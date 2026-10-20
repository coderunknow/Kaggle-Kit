import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkProject,
  compareVersions,
  installCommand,
  meetsNodeRequirement,
  nodeRequirement,
  openBrowserCommand,
  parseNodeVersion,
  resolvePort,
  waitForHealth,
} from './launcher.mjs';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return port;
}

describe('node version checks', () => {
  it('parses the output of node --version', () => {
    expect(parseNodeVersion('v22.22.3')).toEqual({ major: 22, minor: 22, patch: 3 });
    expect(parseNodeVersion('20.19.0')).toEqual({ major: 20, minor: 19, patch: 0 });
    expect(parseNodeVersion('not a version')).toBeUndefined();
  });

  it('compares versions numerically, not as strings', () => {
    expect(compareVersions({ major: 20, minor: 19, patch: 0 }, { major: 20, minor: 2, patch: 0 })).toBe(1);
    expect(compareVersions({ major: 8, minor: 0, patch: 0 }, { major: 20, minor: 19, patch: 0 })).toBe(-1);
  });

  it('accepts the minimum and newer versions and rejects older ones', () => {
    expect(meetsNodeRequirement(parseNodeVersion('20.19.0'))).toBe(true);
    expect(meetsNodeRequirement(parseNodeVersion('22.0.0'))).toBe(true);
    expect(meetsNodeRequirement(parseNodeVersion('20.18.9'))).toBe(false);
    expect(meetsNodeRequirement(parseNodeVersion('18.20.0'))).toBe(false);
    expect(meetsNodeRequirement(undefined)).toBe(false);
  });

  it('reads the requirement from package.json and falls back safely', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kaggle-kit-launcher-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ engines: { node: '>=20.19' } }),
    );
    expect(nodeRequirement(root)).toBe('20.19');

    await writeFile(path.join(root, 'package.json'), JSON.stringify({}));
    expect(nodeRequirement(root)).toBe('20.19');

    await rm(path.join(root, 'package.json'));
    expect(nodeRequirement(root)).toBe('20.19');
  });
});

describe('project checks', () => {
  it('reports a missing package.json instead of starting anyway', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kaggle-kit-empty-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const result = checkProject(root);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('package.json');
  });

  it('accepts a checkout with a package.json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kaggle-kit-project-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'package.json'), '{}');
    expect(checkProject(root)).toEqual({ ok: true });
  });

  it('uses npm ci when a lockfile exists and npm install otherwise', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kaggle-kit-install-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    expect(installCommand(root).args).toEqual(['install', '--no-audit', '--no-fund']);
    await writeFile(path.join(root, 'package-lock.json'), '{}');
    expect(installCommand(root).args).toEqual(['ci', '--no-audit', '--no-fund']);
  });

  it('has a platform specific browser command', () => {
    const command = openBrowserCommand('http://localhost:8787');
    expect(command.command.length).toBeGreaterThan(0);
    expect(command.args).toContain('http://localhost:8787');
  });
});

describe('the Windows wrapper', () => {
  const script = readFileSync(path.resolve(__dirname, '..', 'scripts', 'start-windows.ps1'), 'utf8');

  it('checks Node.js, its version and npm before starting anything', () => {
    expect(script).toContain('Get-Command node');
    expect(script).toContain('Get-Command npm');
    expect(script).toContain('[version]\'20.19.0\'');
    expect(script).toContain('node --version');
  });

  it('delegates to the shared launcher and keeps the exit code', () => {
    expect(script).toContain('tools\\launcher.mjs');
    expect(script).toContain('@launcherArguments');
    expect(script).toContain('exit $exitCode');
  });

  it('never asks for administrator rights or credentials', () => {
    expect(script.toLowerCase()).not.toContain('runas');
    expect(script.toLowerCase()).not.toContain('-verb runas');
    expect(script).not.toContain('secrets.json');
    expect(script).not.toContain('api_key');
  });
});

describe('port selection', () => {
  it('keeps a free preferred port', async () => {
    const result = await resolvePort(0);
    expect(result.moved).toBe(false);
    expect(result.conflict).toBeUndefined();
  });

  it('moves to the next port when the preferred one is busy', async () => {
    const server = createNetServer();
    const busy = await listen(server);
    cleanups.unshift(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const result = await resolvePort(busy);
    expect(result.moved).toBe(true);
    expect(result.port).toBeGreaterThan(busy);
    expect(result.notice).toContain(String(busy));
  });

  it('reports an explicit port conflict instead of moving silently', async () => {
    const server = createNetServer();
    const busy = await listen(server);
    cleanups.unshift(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const result = await resolvePort(busy, { forced: true });
    expect(result.conflict).toContain(String(busy));
    expect(result.port).toBe(busy);
  });
});

describe('backend readiness', () => {
  it('waits until the health endpoint answers', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/api/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const port = await listen(server);

    const result = await waitForHealth(`http://127.0.0.1:${port}/api/health`, {
      timeoutMs: 5000,
      intervalMs: 50,
    });
    expect(result.ok).toBe(true);
  });

  it('fails with a clear reason when the backend never becomes ready', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    const port = await listen(server);

    const result = await waitForHealth(`http://127.0.0.1:${port}/api/health`, {
      timeoutMs: 600,
      intervalMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('503');
  });

  it('stops waiting when the backend process has already exited', async () => {
    const result = await waitForHealth('http://127.0.0.1:9/api/health', {
      timeoutMs: 5000,
      intervalMs: 10,
      isAlive: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('exited');
  });
});
