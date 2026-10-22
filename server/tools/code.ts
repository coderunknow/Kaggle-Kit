import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CodeSandboxSettings } from '../../shared/tools/types';

export class CodeSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeSandboxError';
  }
}

export interface CodeRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimited: boolean;
  durationMs: number;
}

/** Deterministic, shell-free name so a run can always be force-removed. */
export function sandboxContainerName(): string {
  return `kaggle-kit-sandbox-${randomUUID()}`;
}

/**
 * The exact `docker run` argv. Exported for tests: the flags are the
 * isolation contract (no network, read-only root, dropped capabilities,
 * unprivileged user, bounded resources, never pull).
 *
 * The program is fed on stdin (`python -`), never as an argv element, so
 * model-generated code cannot appear in host process listings or be
 * reinterpreted as a flag.
 */
export function buildDockerRunArgs(settings: CodeSandboxSettings, containerName: string): string[] {
  return [
    'run', '--rm', '--pull=never',
    '--name', containerName,
    '--interactive',
    '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--pids-limit', String(boundedInt(settings.maxProcesses, 1, 128, 32)),
    '--memory', `${boundedInt(settings.memoryMb, 64, 2048, 128)}m`,
    '--memory-swap', `${boundedInt(settings.memoryMb, 64, 2048, 128)}m`,
    '--cpus', String(boundedDecimal(settings.cpuCores, 0.1, 2, 0.5)),
    '--user', '65534:65534',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--workdir', '/tmp',
    '--entrypoint', 'python',
    settings.image,
    '-I', '-S', '-',
  ];
}

function restrictedCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/**
 * Force-remove a sandbox container by name. Killing the `docker run` CLI is
 * not sufficient: the CLI forwards SIGTERM but a SIGKILL (or a crashed
 * proxy) leaves the container running under the daemon. `docker rm -f`
 * against the known name is the only reliable cleanup, so every stop path
 * (timeout, abort, output limit) issues it in addition to the signal.
 */
export function forceRemoveContainer(containerName: string, env: NodeJS.ProcessEnv = restrictedCliEnv()): Promise<void> {
  return new Promise((resolve) => {
    let remover;
    try {
      remover = spawn('docker', ['rm', '--force', containerName], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        env,
      });
    } catch {
      resolve();
      return;
    }
    const guard = setTimeout(() => {
      try { remover.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 5_000);
    guard.unref?.();
    remover.once('error', () => { clearTimeout(guard); resolve(); });
    remover.once('close', () => { clearTimeout(guard); resolve(); });
  });
}

export async function runPythonInDocker(
  code: string,
  settings: CodeSandboxSettings,
  signal?: AbortSignal,
): Promise<CodeRunResult> {
  if (settings.provider !== 'docker') throw new CodeSandboxError('Python execution is disabled. Configure a digest-pinned image and Docker sandbox first.');
  if (!/^python:3\.(?:11|12|13)-alpine@sha256:[a-f0-9]{64}$/.test(settings.image)) {
    throw new CodeSandboxError('The Docker image must be an allowlisted Python Alpine version pinned by sha256 digest.');
  }
  if (!code.trim() || Buffer.byteLength(code, 'utf8') > 8_192) throw new CodeSandboxError('Python code must contain 1–8,192 bytes.');

  if (signal?.aborted) throw new CodeSandboxError('Python execution was cancelled before Docker started.');

  const containerName = sandboxContainerName();
  const args = buildDockerRunArgs(settings, containerName);
  const timeoutMs = boundedInt(settings.timeoutMs, 1_000, 60_000, 10_000);
  const outputLimit = boundedInt(settings.outputBytes, 256, 32_768, 8_192);
  const env = restrictedCliEnv();
  const startedAt = Date.now();
  let cleanupStarted = false;
  const cleanupContainer = () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void forceRemoveContainer(containerName, env);
  };

  return new Promise<CodeRunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn('docker', args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch {
      reject(new CodeSandboxError('Docker could not be started. No host-code fallback is permitted.'));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let outputLimited = false;
    let timedOut = false;
    let settled = false;
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (limit: boolean) => {
      if (limit) outputLimited = true;
      if (stopping) return;
      stopping = true;
      // Remove the container itself first (reliable even if the CLI is
      // about to be SIGKILLed), then stop the CLI.
      cleanupContainer();
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref?.();
    };
    const onAbort = () => stop(false);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const append = (target: Buffer[], chunk: Buffer) => {
      const remaining = outputLimit - captured;
      if (remaining <= 0) {
        stop(true);
        return;
      }
      const clipped = chunk.subarray(0, remaining);
      target.push(Buffer.from(clipped));
      captured += clipped.byteLength;
      if (clipped.byteLength < chunk.byteLength) stop(true);
    };
    child.stdout?.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.stdin?.on('error', () => { /* the run is already stopping */ });
    child.stdin?.end(code, 'utf8');
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      cleanupContainer();
      if (error.code === 'ENOENT') reject(new CodeSandboxError('Docker is not installed or not on PATH. Python execution is disabled; no fallback ran on the host.'));
      else reject(new CodeSandboxError('The Docker sandbox could not be started. No host-code fallback ran.'));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop(false);
    }, timeoutMs);
    timer.unref?.();
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      // `--rm` removes the container on normal exit; when we stopped the
      // run ourselves, make sure removal was issued even if the CLI died
      // before the daemon processed it.
      if (stopping) cleanupContainer();
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputLimited,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function boundedInt(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
function boundedDecimal(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value)) * 10) / 10 : fallback;
}
