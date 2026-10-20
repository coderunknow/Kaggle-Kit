/**
 * Real-Docker integration check for the Python sandbox.
 *
 * Exercises the exact `runPythonInDocker` path the application uses:
 * a harmless program, output bounding, timeout cleanup, abort cleanup and
 * fail-closed behavior for a missing image. Verifies after the timeout and
 * abort cases that no `kaggle-kit-sandbox-*` container is left behind
 * (killing the docker CLI alone does not stop a container).
 *
 * Usage (Docker-capable machine):
 *   SANDBOX_TEST_IMAGE='python:3.12-alpine@sha256:<digest>' npx tsx tools/sandbox-integration.mts
 *
 * Without Docker or without the env var the script prints SKIP and exits 0,
 * unless SANDBOX_TEST_REQUIRED=1, in which case it exits 1. CI sets both.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runPythonInDocker } from '../server/tools/code';
import { DEFAULT_CODE_SANDBOX, type CodeSandboxSettings } from '../shared/tools/types';

const exec = promisify(execFile);
const required = process.env.SANDBOX_TEST_REQUIRED === '1';
const image = process.env.SANDBOX_TEST_IMAGE ?? '';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) process.stdout.write(`  ok   ${name}\n`);
  else {
    failures += 1;
    process.stdout.write(`  FAIL ${name}${detail ? `: ${detail}` : ''}\n`);
  }
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await exec('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

async function leftoverContainers(): Promise<string> {
  const { stdout } = await exec('docker', ['ps', '-a', '--filter', 'name=kaggle-kit-sandbox-', '--format', '{{.Names}}']);
  return stdout.trim();
}

async function main(): Promise<void> {
  if (!/^python:3\.(?:11|12|13)-alpine@sha256:[a-f0-9]{64}$/.test(image)) {
    process.stdout.write('SKIP sandbox integration: SANDBOX_TEST_IMAGE is not a digest-pinned Python Alpine image.\n');
    if (required) process.exit(1);
    return;
  }
  if (!(await dockerAvailable())) {
    process.stdout.write('SKIP sandbox integration: Docker is not available.\n');
    if (required) process.exit(1);
    return;
  }
  // The application never pulls; the operator/CI must have the image.
  try {
    await exec('docker', ['image', 'inspect', image]);
  } catch {
    process.stdout.write(`SKIP sandbox integration: image ${image} is not present locally.\n`);
    if (required) process.exit(1);
    return;
  }

  const settings: CodeSandboxSettings = {
    ...DEFAULT_CODE_SANDBOX,
    provider: 'docker',
    image,
    timeoutMs: 5_000,
    outputBytes: 256,
  };

  const hello = await runPythonInDocker('print("sandbox-ok")', settings);
  check('a harmless program runs and returns its output', hello.exitCode === 0 && hello.stdout.includes('sandbox-ok'), JSON.stringify(hello));

  const noisy = await runPythonInDocker('print("x" * 100000)', settings);
  check('output is bounded and flagged', noisy.outputLimited && Buffer.byteLength(noisy.stdout + noisy.stderr, 'utf8') <= 256, JSON.stringify({ bytes: Buffer.byteLength(noisy.stdout + noisy.stderr, 'utf8'), outputLimited: noisy.outputLimited }));

  const timed = await runPythonInDocker('import time; time.sleep(30)', { ...settings, timeoutMs: 1_000 });
  check('a long program times out', timed.timedOut, JSON.stringify(timed));
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  check('no container remains after timeout', (await leftoverContainers()) === '', await leftoverContainers());

  const controller = new AbortController();
  const abortedRun = runPythonInDocker('import time; time.sleep(30)', { ...settings, timeoutMs: 30_000 }, controller.signal);
  setTimeout(() => controller.abort(), 500);
  const aborted = await abortedRun;
  check('an aborted program stops promptly', aborted.durationMs < 15_000, JSON.stringify({ durationMs: aborted.durationMs }));
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  check('no container remains after abort', (await leftoverContainers()) === '', await leftoverContainers());

  let missingImageFailedClosed = false;
  try {
    const result = await runPythonInDocker('print(1)', { ...settings, image: `python:3.12-alpine@sha256:${'0'.repeat(64)}` });
    missingImageFailedClosed = result.exitCode !== 0;
  } catch {
    missingImageFailedClosed = true;
  }
  check('a missing image fails closed without host execution', missingImageFailedClosed);

  process.stdout.write(failures === 0 ? '\nsandbox integration: all checks passed\n' : `\nsandbox integration: ${failures} failure(s)\n`);
  if (failures > 0) process.exit(1);
}

await main();
