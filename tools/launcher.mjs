#!/usr/bin/env node
/**
 * One-command launcher for Kaggle-Kit.
 *
 * It is deliberately dependency free: it runs before `node_modules` exists and
 * checks everything the Windows wrapper cannot check portably (dependencies,
 * build output, a free port, backend readiness). The PowerShell script in
 * `scripts/start-windows.ps1` only checks Node/npm and delegates here, so the
 * logic can be tested on any platform.
 *
 * No credential is read, written or printed here. The proxy owns the secret
 * store; this launcher only starts the proxy and prints the local URL.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 8787;
export const DEFAULT_NODE_REQUIREMENT = '20.19';
export const READY_TIMEOUT_MS = 45_000;

/** Parse `v22.22.3` or `22.22.3` into numeric parts. */
export function parseNodeVersion(output) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(output).trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

/** Compare two parsed versions. */
export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export function meetsNodeRequirement(version, requirement = DEFAULT_NODE_REQUIREMENT) {
  const minimum = typeof requirement === 'string' ? parseNodeVersion(requirement) : requirement;
  if (!minimum || !version) return false;
  return compareVersions(version, minimum) >= 0;
}

/** Read the `engines.node` requirement without assuming a semver library. */
export function nodeRequirement(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const declared = manifest?.engines?.node;
    if (typeof declared !== 'string') return DEFAULT_NODE_REQUIREMENT;
    const match = /(\d+\.\d+(?:\.\d+)?)/.exec(declared);
    return match ? match[1] : DEFAULT_NODE_REQUIREMENT;
  } catch {
    return DEFAULT_NODE_REQUIREMENT;
  }
}

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host });
    const done = (free) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(free);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', (error) => {
      // ECONNREFUSED means nothing is listening; anything else is treated as
      // "not obviously free" so the launcher never picks a port blindly.
      done(error.code === 'ECONNREFUSED');
    });
  });
}

/**
 * Pick the preferred port, or the next free one when it was not forced.
 * A forced port reports the conflict instead of silently moving.
 */
export async function resolvePort(preferred, options = {}) {
  const { forced = false, host = '127.0.0.1', attempts = 25 } = options;
  if (await isPortFree(preferred, host)) return { port: preferred, moved: false };

  if (forced) {
    return {
      port: preferred,
      moved: false,
      conflict: `Port ${preferred} is already in use. Stop the process that listens on it, or start the launcher with a different -Port.`,
    };
  }

  for (let offset = 1; offset <= attempts; offset += 1) {
    const candidate = preferred + offset;
    if (await isPortFree(candidate, host)) {
      return {
        port: candidate,
        moved: true,
        notice: `Port ${preferred} is in use; the launcher uses ${candidate} instead.`,
      };
    }
  }

  return {
    port: preferred,
    moved: false,
    conflict: `Ports ${preferred}-${preferred + attempts} are all in use. Free one of them or pass a different -Port.`,
  };
}

/** Poll the health endpoint until the backend answers or the deadline passes. */
export async function waitForHealth(url, options = {}) {
  const { timeoutMs = READY_TIMEOUT_MS, intervalMs = 250, fetchImpl = fetch, isAlive = () => true } = options;
  const deadline = Date.now() + timeoutMs;
  let lastDetail = 'the backend did not answer /api/health yet';

  while (Date.now() < deadline) {
    if (!isAlive()) return { ok: false, detail: 'the backend process exited during start-up' };
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return { ok: true, detail: 'the backend is ready' };
      lastDetail = `the backend answered with HTTP ${response.status}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }

  return { ok: false, detail: `the backend was not ready after ${Math.round(timeoutMs / 1000)} s (${lastDetail})` };
}

/** The install command for a checkout without node_modules. */
export function installCommand(root) {
  return existsSync(join(root, 'package-lock.json'))
    ? { command: npmCommand(), args: ['ci', '--no-audit', '--no-fund'] }
    : { command: npmCommand(), args: ['install', '--no-audit', '--no-fund'] };
}

export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function openBrowserCommand(url) {
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  if (process.platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

function runChild(spec, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
      shell: options.shell ?? false,
    });
    child.once('error', (error) => resolvePromise({ code: 1, error }));
    child.once('exit', (code, signal) => resolvePromise({ code: code ?? (signal ? 1 : 0) }));
  });
}

const log = (message, level = 'info') => {
  const prefix = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARNING' : 'Kaggle-Kit';
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${prefix}: ${message}\n`);
};

const requiredBuildFiles = (root) => [
  join(root, 'dist', 'server', 'index.js'),
  join(root, 'dist', 'client', 'index.html'),
];

/** Validate the checkout before doing any work. */
export function checkProject(root) {
  if (!existsSync(join(root, 'package.json'))) {
    return { ok: false, detail: `package.json was not found in ${root}. Run the launcher from the Kaggle-Kit folder.` };
  }
  return { ok: true };
}

/**
 * Start the built backend, wait until it is ready and open the page.
 * Returns a promise that settles when the backend exits or the user stops it.
 */
export async function runLauncher(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const explicitPort = Number.isInteger(options.port) && options.port > 0 ? options.port : undefined;
  const check = checkProject(root);
  if (!check.ok) {
    log(check.detail, 'error');
    return 1;
  }

  const requirement = nodeRequirement(root);
  const version = parseNodeVersion(process.version);
  if (!meetsNodeRequirement(version, requirement)) {
    log(
      `Node.js ${process.version} is too old. Kaggle-Kit needs Node.js ${requirement} or newer. Install it from https://nodejs.org/ and run the launcher again.`,
      'error',
    );
    return 1;
  }
  log(`Node.js ${process.version} detected (requires ${requirement}+).`);

  const missingBuild = requiredBuildFiles(root).filter((file) => !existsSync(file));
  if (missingBuild.length > 0) {
    // Only a source checkout needs dependencies. A released application
    // bundle contains the built client and the bundled backend, so it starts
    // without node_modules and without the npm registry.
    if (!existsSync(join(root, 'node_modules'))) {
      if (options.noInstall) {
        log('Dependencies are missing (node_modules). Run "npm ci" or omit -NoInstall.', 'error');
        return 1;
      }
      log('Dependencies are missing; downloading them from the npm registry (network required)…');
      const install = installCommand(root);
      const installed = await runChild(install, { cwd: root, shell: process.platform === 'win32' });
      if (installed.code !== 0) {
        log('Installing the dependencies failed. Check the network connection and run "npm ci" manually.', 'error');
        return installed.code || 1;
      }
    }

    log('Building the browser client and the proxy (this can take a minute)…');
    const built = await runChild({ command: npmCommand(), args: ['run', 'build'] }, {
      cwd: root,
      shell: process.platform === 'win32',
    });
    if (built.code !== 0) {
      log('The build failed. The message above names the file and the reason.', 'error');
      return built.code || 1;
    }
  }

  const envPort = Number.parseInt(process.env.KAGGLE_KIT_PORT ?? '', 10);
  const preferredPort = explicitPort ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT);
  const portResult = await resolvePort(preferredPort, { forced: explicitPort !== undefined });
  if (portResult.conflict) {
    log(portResult.conflict, 'error');
    return 1;
  }
  if (portResult.notice) log(portResult.notice, 'warn');

  const port = portResult.port;
  const url = `http://localhost:${port}`;
  log(`Starting the local proxy on http://127.0.0.1:${port} …`);

  let child;
  try {
    child = spawn(process.execPath, [join(root, 'dist', 'server', 'index.js')], {
      cwd: root,
      env: { ...process.env, KAGGLE_KIT_PORT: String(port) },
      stdio: 'inherit',
    });
  } catch (error) {
    log(`The backend could not be started: ${error instanceof Error ? error.message : String(error)}`, 'error');
    return 1;
  }

  let exited = false;
  let stopping = false;
  let exitCode = 0;
  child.once('exit', (code, signal) => {
    exited = true;
    exitCode = code ?? (signal ? 1 : 0);
  });
  child.once('error', (error) => {
    exited = true;
    log(`The backend could not be started: ${error.message}`, 'error');
    exitCode = 1;
  });

  const stop = () => {
    if (stopping || exited) return;
    stopping = true;
    log('Stopping the proxy…');
    child.kill();
    const force = setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, 5000);
    force.unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const readiness = await waitForHealth(`http://127.0.0.1:${port}/api/health`, {
    isAlive: () => !exited && !stopping,
  });

  if (!readiness.ok) {
    if (stopping) return 0;
    log(`The backend did not start: ${readiness.detail}`, 'error');
    log('Check that the port is free and that "npm run build" succeeds, then try again.', 'error');
    if (!exited) child.kill();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    return 1;
  }

  log(`Ready. Open ${url} in the browser.`);
  log('Add the tunnel URL and the API key of the notebook in Settings → Connections.');
  log('Press Ctrl+C to stop the proxy.');

  if (!options.noBrowser) {
    const opener = openBrowserCommand(url);
    const opened = await runChild(opener, { stdio: 'ignore' });
    if (opened.code !== 0) {
      log(`The browser could not be opened automatically. Open ${url} manually.`, 'warn');
    }
  }

  return new Promise((resolvePromise) => {
    child.once('exit', () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      if (exitCode !== 0) {
        log(`The backend stopped with exit code ${exitCode}. The message above explains why.`, 'error');
      }
      resolvePromise(exitCode);
    });
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) options.port = value;
      index += 1;
    } else if (arg === '--no-browser') {
      options.noBrowser = true;
    } else if (arg === '--no-install') {
      options.noInstall = true;
    }
  }
  return options;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runLauncher(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error) => {
      log(error instanceof Error ? error.message : String(error), 'error');
      process.exit(1);
    });
}
