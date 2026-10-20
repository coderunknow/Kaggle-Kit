import { describe, expect, it } from 'vitest';

import { DEFAULT_CODE_SANDBOX } from '../../shared/tools/types';
import { runPythonInDocker, CodeSandboxError } from './code';

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
});
