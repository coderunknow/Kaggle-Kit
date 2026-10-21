import { describe, expect, it } from 'vitest';

import { DEFAULT_CODE_SANDBOX } from '../../shared/tools/types';
import { buildDockerRunArgs, runPythonInDocker, sandboxContainerName, CodeSandboxError } from './code';

const pinned = {
  ...DEFAULT_CODE_SANDBOX,
  provider: 'docker' as const,
  image: `python:3.12-alpine@sha256:${'a'.repeat(64)}`,
};

describe('fail-closed Python sandbox configuration', () => {
  it('does not execute when the sandbox provider is disabled', async () => {
    await expect(runPythonInDocker('print("must not run")', {
      ...DEFAULT_CODE_SANDBOX,
      provider: 'disabled',
    })).rejects.toThrow(/Python execution is disabled/i);
  });

  it('rejects mutable, unpinned, or non-Python images before starting Docker', async () => {
    for (const image of ['python:3.12-alpine', 'alpine:latest', `python:3.12-alpine@sha256:${'A'.repeat(64)}`]) {
      await expect(runPythonInDocker('print(1)', { ...pinned, image })).rejects.toThrow(CodeSandboxError);
    }
  });

  it('rejects empty and oversized code before launching a process', async () => {
    await expect(runPythonInDocker('   ', pinned)).rejects.toThrow(/must contain/i);
    await expect(runPythonInDocker('x'.repeat(8_193), pinned)).rejects.toThrow(/8,192 bytes/i);
  });

  it('does not start Docker for a request cancelled before dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runPythonInDocker('print(1)', pinned, controller.signal)).rejects.toThrow(/cancelled before Docker started/);
  });

  it('builds the exact isolation argv with a removable container name', () => {
    const name = sandboxContainerName();
    expect(name).toMatch(/^kaggle-kit-sandbox-[0-9a-f-]{36}$/);
    expect(sandboxContainerName()).not.toBe(name);
    const args = buildDockerRunArgs(pinned, name);
    expect(args).toContain('--name');
    expect(args[args.indexOf('--name') + 1]).toBe(name);
    for (const expected of ['--rm', '--pull=never', '--interactive', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user']) {
      expect(args, expected).toContain(expected);
    }
    // The program comes from stdin, never from argv.
    expect(args.slice(-3)).toEqual(['-I', '-S', '-']);
    expect(args).not.toContain('-c');
    // No environment is passed into the container.
    expect(args.some((arg) => arg === '-e' || arg === '--env' || arg.startsWith('--env='))).toBe(false);
    // No host mounts of any kind.
    expect(args.some((arg) => arg === '-v' || arg === '--volume' || arg === '--mount')).toBe(false);
  });

  it('clamps out-of-range resource settings into the enforced argv bounds', () => {
    const args = buildDockerRunArgs({
      ...pinned,
      memoryMb: 999_999,
      cpuCores: 64,
      maxProcesses: 999_999,
    }, 'kaggle-kit-sandbox-test');
    expect(args[args.indexOf('--memory') + 1]).toBe('2048m');
    expect(args[args.indexOf('--cpus') + 1]).toBe('2');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('128');
  });
});
