import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_TOOL_PROFILE_SETTINGS } from '../shared/tools/types';
import { SecretStore } from './secrets';

const directories: string[] = [];

async function makeStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kaggle-kit-secret-store-'));
  directories.push(directory);
  const file = path.join(directory, 'secrets.json');
  return { directory, file, store: new SecretStore(file) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('versioned server secret store', () => {
  it('migrates a valid v1 file to v2 without losing stored keys', async () => {
    const { file, store } = await makeStore();
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      secrets: { 'model-key': { apiKey: 'legacy-secret-value', createdAt: '2026-01-01T00:00:00.000Z' } },
    }));

    expect(await store.get('model-key')).toBe('legacy-secret-value');
    const migrated = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    expect(migrated.version).toBe(2);
    expect(migrated.toolProfiles).toEqual({});
    expect(migrated.secrets).toHaveProperty('model-key');
  });

  it('stores keys and tool profiles with private file and directory modes', async () => {
    const { directory, file, store } = await makeStore();
    await store.set('api-key', 'private-value');
    await store.setToolProfile('profile-1', { ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS), enabled: true });
    const fileMode = (await fs.stat(file)).mode & 0o777;
    const directoryMode = (await fs.stat(directory)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(directoryMode).toBe(0o700);
    expect((await store.getToolProfile('profile-1'))?.enabled).toBe(true);
  });

  it('tightens permissions on an existing valid store before returning its contents', async () => {
    const { directory, file, store } = await makeStore();
    await fs.writeFile(file, JSON.stringify({ version: 2, secrets: {}, toolProfiles: {} }), { mode: 0o644 });
    await fs.chmod(directory, 0o755);

    expect(await store.list()).toEqual([]);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('never persists direct sensitive HTTP credentials in a tool profile', async () => {
    const { file, store } = await makeStore();
    const unsafe = {
      ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
      httpTools: [{
        id: 'search', name: 'Search', description: 'Read search data', endpoint: 'https://api.example.com/search', method: 'GET',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, headers: [{ name: 'Authorization', value: 'do-not-persist-this' }],
        permission: 'unknown', timeoutMs: 5000,
      }],
    } as never;
    await store.setToolProfile('profile-1', unsafe);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain('do-not-persist-this');
    const settings = await store.getToolProfile('profile-1');
    expect(settings?.httpTools[0]?.headers).toEqual([]);
  });

  it('serializes concurrent mutations without losing keys or profiles', async () => {
    const { store } = await makeStore();
    await Promise.all([
      store.set('key-a', 'test-secret-a'),
      store.set('key-b', 'test-secret-b'),
      store.setToolProfile('profile-a', { ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS), enabled: true }),
      store.setToolProfile('profile-b', { ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS), historyPersistence: true }),
    ]);

    expect(await store.get('key-a')).toBe('test-secret-a');
    expect(await store.get('key-b')).toBe('test-secret-b');
    expect((await store.getToolProfile('profile-a'))?.enabled).toBe(true);
    expect((await store.getToolProfile('profile-b'))?.historyPersistence).toBe(true);
  });

  it('clear removes keys but preserves non-secret tool profiles', async () => {
    const { store } = await makeStore();
    await store.set('api-key', 'clear-me');
    await store.setToolProfile('profile-1', { ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS), enabled: true });

    await store.clear();

    expect(await store.get('api-key')).toBeNull();
    expect(await store.list()).toEqual([]);
    expect((await store.getToolProfile('profile-1'))?.enabled).toBe(true);
  });

  it('supports deleting a profile without exposing stored keys', async () => {
    const { store } = await makeStore();
    await store.setToolProfile('profile-1', structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS));
    expect(await store.deleteToolProfile('profile-1')).toBe(true);
    expect(await store.getToolProfile('profile-1')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('rejects malformed, unsupported-version and non-record files without overwriting them', async () => {
    const { file, store } = await makeStore();
    for (const invalid of [
      { version: 2, secrets: [], toolProfiles: {} },
      { version: 2, secrets: {}, toolProfiles: [] },
      { version: 3, secrets: {}, toolProfiles: {} },
      { version: 1, secrets: { 'bad id!': { apiKey: 'x', createdAt: 'now' } } },
    ]) {
      const contents = JSON.stringify(invalid);
      await fs.writeFile(file, contents);
      await expect(store.list()).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe(contents);
    }
  });
});
