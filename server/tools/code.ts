import { spawn } from 'node:child_process';
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

  const args = [
    'run', '--rm', '--pull=never',
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
    '-I', '-S', '-c', code,
  ];
  const timeoutMs = boundedInt(settings.timeoutMs, 1_000, 60_000, 10_000);
  const outputLimit = boundedInt(settings.outputBytes, 256, 32_768, 8_192);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const startedAt = Date.now();

  return new Promise<CodeRunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn('docker', args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
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
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
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
