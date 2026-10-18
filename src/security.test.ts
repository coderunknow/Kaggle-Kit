/**
 * Repository level guard rails.
 *
 * These tests scan the shipped source for the two mistakes that are easiest
 * to make and hardest to notice: a hard coded tunnel URL and a committed
 * credential.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCANNED_DIRECTORIES = ['src', 'server', 'shared'];
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);

function collectFiles(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
      continue;
    }
    if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) continue;
    // The guard rails themselves contain the patterns they look for.
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    files.push(full);
  }

  return files;
}

const sourceFiles = SCANNED_DIRECTORIES.flatMap((directory) =>
  collectFiles(path.join(ROOT, directory)),
);

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('source hygiene', () => {
  it('finds source files to scan', () => {
    expect(sourceFiles.length).toBeGreaterThan(10);
  });

  it('does not hard code a Cloudflare Quick Tunnel URL', () => {
    // The hostname suffix may appear in detection helpers, a full URL may not.
    const pattern = /https?:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const offenders = sourceFiles.filter((file) => pattern.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('does not hard code an API key', () => {
    const pattern = /(api[_-]?key|token|secret)\s*[:=]\s*['"][^'"]{12,}['"]/i;
    const offenders = sourceFiles.filter((file) => pattern.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('never builds a URL that contains a credential', () => {
    const interpolation = /\$\{[^}]*api[_-]?key[^}]*\}/i;
    const offenders = sourceFiles.filter((file) =>
      read(file)
        .split('\n')
        .some(
          (line) =>
            interpolation.test(line) &&
            (line.includes('http://') || line.includes('https://') || line.includes('?')),
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the model weights and the secret store out of git', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toContain('*.gguf');
    expect(ignore).toContain('.data/');
    expect(ignore).toContain('secrets.json');
  });
});
