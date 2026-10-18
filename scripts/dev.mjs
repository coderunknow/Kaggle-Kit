/**
 * Development launcher.
 *
 * Starts the local proxy backend and the Vite dev server together and keeps
 * their output prefixed. The Vite dev server proxies `/api` to the backend.
 */

import { spawn } from 'node:child_process';

const BACKEND_PORT = process.env.KAGGLE_KIT_PORT ?? '8787';

const processes = [];

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });

  const prefix = `[${name}] `;
  const forward = (stream, target) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
  };

  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    shutdown();
  });

  processes.push(child);
  return child;
}

function shutdown() {
  for (const child of processes) {
    if (!child.killed) child.kill('SIGTERM');
  }
  processes.length = 0;
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run('backend', 'npx', ['tsx', 'watch', 'server/index.ts'], {
  KAGGLE_KIT_PORT: BACKEND_PORT,
});
run('client', 'npx', ['vite', '--host', '0.0.0.0']);
