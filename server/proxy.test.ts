import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadServerConfig } from './config';
import { createLogger } from './logger';
import { ProxyService } from './proxy';
import { SecretStore } from './secrets';

/**
 * Capabilities are detected per endpoint *and* per credential. A key that
 * was rotated or replaced must not inherit a streaming verification that was
 * made with the old key, and a second profile that points at the same host
 * with a different key must be detected on its own.
 */

const BASE_URL = 'http://127.0.0.1:9999/v1';

function createProxy() {
  const config = loadServerConfig({}, process.cwd());
  const store = new SecretStore(path.join(os.tmpdir(), `kaggle-kit-proxy-${Date.now()}.json`));
  const logger = createLogger({ sink: () => undefined });
  return new ProxyService(config, store, logger);
}

function createFetchStub() {
  const calls: string[] = [];
  const stub = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push(url);

    if (url.endsWith('/chat/completions')) {
      return new Response('data: {"choices":[{"delta":{"content":"O"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    return new Response('{"error":"not found"}', { status: 404 });
  });

  vi.stubGlobal('fetch', stub);
  return { stub, calls };
}

describe('the capability cache of the proxy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not reuse a streaming verification for another API key', async () => {
    const proxy = createProxy();
    const { stub, calls } = createFetchStub();

    const probe = await proxy.probeStreaming(
      { baseUrl: BASE_URL, apiKey: 'key-a' },
      { model: 'mock-model', timeoutMs: 5_000 },
    );
    expect(probe.supported).toBe(true);

    const sameKey = await proxy.detectCapabilities(BASE_URL, 'key-a', 5_000);
    expect(sameKey.streamingVerified).toBe(true);

    const otherKey = await proxy.detectCapabilities(BASE_URL, 'key-b', 5_000);
    expect(otherKey.streamingVerified).toBe(false);

    // key-b reached the endpoint for capability detection instead of reusing
    // the entry of key-a.
    expect(calls.filter((url) => url.endsWith('/props'))).toHaveLength(2);
    expect(stub).toHaveBeenCalled();
  });

  it('answers a repeated probe for the same key from the cache', async () => {
    const proxy = createProxy();
    const { calls } = createFetchStub();

    await proxy.probeStreaming({ baseUrl: BASE_URL, apiKey: 'key-a' }, { model: 'm', timeoutMs: 5_000 });
    const before = calls.length;

    const again = await proxy.probeStreaming(
      { baseUrl: BASE_URL, apiKey: 'key-a' },
      { model: 'm', timeoutMs: 5_000 },
    );

    expect(again.supported).toBe(true);
    expect(again.detail).toMatch(/earlier/i);
    expect(calls).toHaveLength(before);
  });

  it('keeps the key out of the cache key it stores internally', () => {
    const proxy = createProxy();
    const internal = proxy as unknown as { capabilityKey: (url: string, key?: string) => string };
    const keyed = internal.capabilityKey(BASE_URL, 'super-secret-key');

    expect(keyed).not.toContain('super-secret-key');
    expect(keyed).toContain(BASE_URL);
  });
});
