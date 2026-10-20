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
  // Delegate to the (stubbed) global fetch; DNS pinning itself is covered
  // by server/pinnedFetch.test.ts against real sockets.
  return new ProxyService(config, store, logger, (input, init) => globalThis.fetch(input, init));
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

  it('verifies a complete synthetic native-tool round trip before reporting support', async () => {
    const proxy = createProxy();
    const bodies: Array<Record<string, unknown>> = [];
    const responses = [
      {
        choices: [{
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-call-1', type: 'function', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        }],
      },
      { choices: [{ message: { role: 'assistant', content: 'KAGGLE_KIT_TOOL_PROBE_OK' }, finish_reason: 'stop' }] },
    ];
    const stub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error('Unexpected capability-probe request.');
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);

    const result = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000 });

    expect(result.status).toBe('supported_verified');
    expect(result.detail).toMatch(/two-step native tool round trip/i);
    // Streaming support is probed separately; this stub cannot answer the
    // streamed request, so streaming honestly stays unverified.
    expect(result.streamingSupported).toBe(false);
    expect(stub).toHaveBeenCalledTimes(3);
    const followUp = bodies[1]!;
    const messages = followUp.messages as Array<Record<string, unknown>>;
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'probe-call-1', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }],
    });
    expect(messages[3]).toMatchObject({
      role: 'tool', tool_call_id: 'probe-call-1', name: 'kaggle_kit_capability_probe',
      content: '{"ok":true,"result":"synthetic-no-op"}',
    });
    expect(followUp.tool_choice).toBe('auto');

    const cached = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000 });
    expect(cached.status).toBe('supported_verified');
    expect(stub).toHaveBeenCalledTimes(3);

    responses.push(
      {
        choices: [{
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-call-2', type: 'function', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        }],
      },
      { choices: [{ message: { role: 'assistant', content: 'KAGGLE_KIT_TOOL_PROBE_OK' }, finish_reason: 'stop' }] },
    );
    const refreshed = await proxy.probeToolCalling(
      { baseUrl: BASE_URL },
      { model: 'mock-model', timeoutMs: 5_000, force: true },
    );
    expect(refreshed.status).toBe('supported_verified');
    expect(stub).toHaveBeenCalledTimes(6);
  });

  it('verifies streamed tool-call fragments independently of the non-streaming result', async () => {
    const proxy = createProxy();
    const jsonResponses = [
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-call-5', type: 'function', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { role: 'assistant', content: 'KAGGLE_KIT_TOOL_PROBE_OK' }, finish_reason: 'stop' }] },
    ];
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"probe-call-5","function":{"name":"kaggle_kit_capability_probe","arguments":"{"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n';
    const stub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (body.stream === true) {
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify(jsonResponses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);

    const result = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000 });

    expect(result.status).toBe('supported_verified');
    expect(result.streamingSupported).toBe(true);
    expect(result.detail).toMatch(/streamed tool-call fragments were also assembled/i);
  });

  it('keeps non-streaming support when streamed fragments are malformed', async () => {
    const proxy = createProxy();
    const jsonResponses = [
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-call-6', type: 'function', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { role: 'assistant', content: 'KAGGLE_KIT_TOOL_PROBE_OK' }, finish_reason: 'stop' }] },
    ];
    const stub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (body.stream === true) {
        // Partial JSON that never completes must not verify streaming.
        return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"kaggle_kit_capability_probe","arguments":"{"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify(jsonResponses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);

    const result = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000 });

    expect(result.status).toBe('supported_verified');
    expect(result.streamingSupported).toBe(false);
  });

  it('refuses a tool-call response with the wrong finish reason', async () => {
    const proxy = createProxy();
    const stub = vi.fn(async () => new Response(JSON.stringify({ choices: [{
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-call-2', type: 'function', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }] },
      finish_reason: 'stop',
    }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', stub);

    const result = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000 });

    expect(result.status).toBe('failed_verification');
    expect(result.detail).toMatch(/finish_reason=tool_calls/i);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('does not verify support when the endpoint rejects a synthetic tool-result follow-up', async () => {
    const proxy = createProxy();
    let requestCount = 0;
    const stub = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) return new Response(JSON.stringify({ choices: [{
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-call-3', type: 'function', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ error: { message: 'tool result messages unsupported' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);

    const result = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000 });

    expect(result.status).toBe('unsupported');
    expect(result.detail).toMatch(/synthetic tool-result follow-up.*HTTP 400/i);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('does not verify support when the follow-up fails to return a final stop response', async () => {
    const proxy = createProxy();
    const responses = [
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-call-4', type: 'function', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { role: 'assistant', content: 'KAGGLE_KIT_TOOL_PROBE_OK', tool_calls: [] }, finish_reason: 'tool_calls' }] },
    ];
    const stub = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', stub);

    const result = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000 });

    expect(result.status).toBe('failed_verification');
    expect(result.detail).toMatch(/did not accept and complete the synthetic tool-result follow-up/i);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('keeps the key out of the cache key it stores internally', () => {
    const proxy = createProxy();
    const internal = proxy as unknown as { capabilityKey: (url: string, key?: string) => string };
    const keyed = internal.capabilityKey(BASE_URL, 'super-secret-key');

    expect(keyed).not.toContain('super-secret-key');
    expect(keyed).toContain(BASE_URL);
    expect(keyed.split('\u0000')).toHaveLength(2);
    const compound = `${keyed}\u0000mock-model`;
    expect(compound.split('\u0000')).toHaveLength(3);
    expect(compound.endsWith('\u0000mock-model')).toBe(true);
  });
});
