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

    // llama.cpp (b11719) serves GET /props at the server root only - never
    // under the OpenAI-compatible /v1 prefix - so the stub mirrors the real
    // route table instead of answering every path.
    if (new URL(url).pathname === '/props') {
      return new Response(JSON.stringify({
        default_generation_settings: { n_predict: -1 },
        chat_template_caps: { supports_reasoning_effort: true },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

  it('re-probes streaming when the model changes instead of reusing the old observation', async () => {
    const proxy = createProxy();
    const probedModels: string[] = [];
    const stub = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
        probedModels.push(body.model ?? '');
        if (body.model === 'model-b') {
          // The new model cannot stream: a cached success would be a lie.
          return new Response('not an event stream', {
            status: 200, headers: { 'Content-Type': 'text/plain' },
          });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"O"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return new Response('{"data":[{"id":"model-a"}]}', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', stub);

    const first = await proxy.probeStreaming(
      { baseUrl: BASE_URL, apiKey: 'key-a' }, { model: 'model-a', timeoutMs: 5_000 },
    );
    expect(first.supported).toBe(true);
    expect(probedModels).toEqual(['model-a']);

    const modelACapability = await proxy.detectCapabilities(BASE_URL, 'key-a', 5_000, 'model-a');
    expect(modelACapability.streamingVerified).toBe(true);
    const modelBCapability = await proxy.detectCapabilities(BASE_URL, 'key-a', 5_000, 'model-b');
    expect(modelBCapability.streamingVerified).toBe(false);
    expect(modelBCapability.streamingEvidence).toBeUndefined();

    const same = await proxy.probeStreaming(
      { baseUrl: BASE_URL, apiKey: 'key-a' }, { model: 'model-a', timeoutMs: 5_000 },
    );
    expect(same.supported).toBe(true);
    expect(same.detail).toMatch(/earlier/i);
    expect(probedModels).toEqual(['model-a']);

    const changed = await proxy.probeStreaming(
      { baseUrl: BASE_URL, apiKey: 'key-a' }, { model: 'model-b', timeoutMs: 5_000 },
    );
    expect(probedModels).toEqual(['model-a', 'model-b']);
    expect(changed.supported).toBe(false);
    expect(changed.detail).toMatch(/content type/i);
  });

  it('expires a streaming verification instead of treating it as valid forever', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-25T00:00:00.000Z'));
      const proxy = createProxy();
      const { calls } = createFetchStub();
      const first = await proxy.probeStreaming(
        { baseUrl: BASE_URL, apiKey: 'key-a' }, { model: 'm', timeoutMs: 5_000 },
      );
      expect(first.supported).toBe(true);
      const before = calls.length;

      vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000 + 1));
      const expired = await proxy.probeStreaming(
        { baseUrl: BASE_URL, apiKey: 'key-a' }, { model: 'm', timeoutMs: 5_000 },
      );
      expect(expired.supported).toBe(true);
      expect(expired.detail).not.toMatch(/earlier/i);
      expect(calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
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

  it('auto-discovers the first model when probeToolCalling or probeStreaming is called with an empty model ID', async () => {
    const proxy = createProxy();
    const stub = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'discovered-model' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (body.stream === true) {
        return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? [];
      if (messages.some((m) => m.role === 'tool')) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'KAGGLE_KIT_TOOL_PROBE_OK' }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'probe-call-auto', type: 'function', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);

    const toolCap = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: '', timeoutMs: 5_000 });
    expect(toolCap.status).toBe('supported_verified');
    expect(toolCap.model).toBe('discovered-model');
    expect(toolCap.protocolVerified).toBe(true);
    expect(toolCap.roundTripVerified).toBe(true);

    // A streaming/props re-detection for the same model preserves the fresh,
    // explicit tool-probe result instead of silently dropping it.
    const detected = await proxy.detectCapabilities(BASE_URL, undefined, 5_000, 'discovered-model');
    expect(detected.toolCalling?.status).toBe('supported_verified');
    // Without a model, nothing is attached and nothing is inferred.
    const anonymous = await proxy.detectCapabilities(BASE_URL, undefined, 5_000);
    expect(anonymous.toolCalling).toBeUndefined();

    const streamCap = await proxy.probeStreaming({ baseUrl: BASE_URL }, { model: '', timeoutMs: 5_000 });
    expect(streamCap.supported).toBe(true);
  });

  it('reports a discovery failure or an empty model list honestly instead of probing a invented model', async () => {
    const proxy = createProxy();
    const failing = vi.fn(async () => new Response('{"error":"boom"}', { status: 500 }));
    vi.stubGlobal('fetch', failing);
    const failedCap = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: '', timeoutMs: 5_000 });
    expect(failedCap.status).toBe('not_verified');
    expect(failedCap.detail).toMatch(/discovery at \/v1\/models failed/i);

    const empty = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', empty);
    const emptyCap = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: '', timeoutMs: 5_000 });
    expect(emptyCap.status).toBe('not_verified');
    expect(emptyCap.detail).toMatch(/reported no models/i);
    // Only the two discovery requests happened: no probe turn was simulated.
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a max_tokens truncation from a genuine protocol failure', async () => {
    const proxy = createProxy();
    const bodies: Array<Record<string, unknown>> = [];
    const stub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '<think>Let me think…' }, finish_reason: 'length' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);

    const result = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000 });
    expect(result.status).toBe('failed_verification');
    expect(result.protocolVerified).toBe(false);
    expect(result.roundTripVerified).toBe(false);
    expect(result.detail).toMatch(/hit max_tokens \(finish_reason=length\)/i);
    // The probe gives a reasoning header room before the function call.
    expect(bodies[0]!.max_tokens).toBe(192);
  });

  it('accepts the acknowledgement token only verbatim with word boundaries and a clean stop', async () => {
    const proxy = createProxy();
    const turnOne = {
      choices: [{
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-call-9', type: 'function', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    };

    // Negative: a longer word containing the token does not pass.
    const okayStub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? [];
      const response = messages.some((m) => m.role === 'tool')
        ? { choices: [{ message: { role: 'assistant', content: 'KAGGLE_KIT_TOOL_PROBE_OKAY' }, finish_reason: 'stop' }] }
        : turnOne;
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', okayStub);
    const okayResult = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000, force: true });
    expect(okayResult.status).toBe('failed_verification');
    expect(okayResult.roundTripVerified).toBe(false);

    // Negative: the token plus an additional tool call does not pass.
    const extraCallStub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? [];
      const response = messages.some((m) => m.role === 'tool')
        ? {
          choices: [{
            message: {
              role: 'assistant',
              content: 'KAGGLE_KIT_TOOL_PROBE_OK',
              tool_calls: [{ id: 'probe-call-x', type: 'function', function: { name: 'kaggle_kit_capability_probe', arguments: '{}' } }],
            },
            finish_reason: 'stop',
          }],
        }
        : turnOne;
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', extraCallStub);
    const extraResult = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000, force: true });
    expect(extraResult.status).toBe('failed_verification');

    // Positive: the token embedded in a sentence with a clean stop passes.
    const embeddedStub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? [];
      const response = messages.some((m) => m.role === 'tool')
        ? { choices: [{ message: { role: 'assistant', content: 'Done. KAGGLE_KIT_TOOL_PROBE_OK.' }, finish_reason: 'stop' }] }
        : turnOne;
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', embeddedStub);
    const embeddedResult = await proxy.probeToolCalling({ baseUrl: BASE_URL }, { model: 'mock-model', timeoutMs: 5_000, force: true });
    expect(embeddedResult.status).toBe('supported_verified');
    expect(embeddedResult.roundTripVerified).toBe(true);
  });
});

describe('the /props capability probe against a llama.cpp-style route table', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubRoutes(routes: Record<string, { status: number; body: unknown }>) {
    const calls: string[] = [];
    const stub = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push(url);
      const route = routes[new URL(url).pathname];
      if (!route) return new Response('{"error":"not found"}', { status: 404 });
      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', stub);
    return { stub, calls };
  }

  const LLAMA_PROPS = {
    default_generation_settings: { n_predict: -1 },
    chat_template_caps: { supports_reasoning_effort: true },
  };

  it('detects the template capability of a b11719-style server that only serves the root /props', async () => {
    const proxy = createProxy();
    const { calls } = stubRoutes({ '/props': { status: 200, body: LLAMA_PROPS } });

    const capabilities = await proxy.detectCapabilities(BASE_URL, undefined, 5_000);

    expect(capabilities.templateReasoningEffortSupported).toBe(true);
    // The root probe answered, so no /v1/props request was invented.
    expect(calls).toEqual(['http://127.0.0.1:9999/props']);
  });

  it('falls back to /v1/props for a server that mounts the metadata under the API prefix', async () => {
    const proxy = createProxy();
    const { calls } = stubRoutes({ '/v1/props': { status: 200, body: LLAMA_PROPS } });

    const capabilities = await proxy.detectCapabilities(BASE_URL, undefined, 5_000);

    expect(capabilities.templateReasoningEffortSupported).toBe(true);
    expect(calls).toEqual(['http://127.0.0.1:9999/props', 'http://127.0.0.1:9999/v1/props']);
  });

  it('reports the honest missing-endpoint note when neither /props route exists', async () => {
    const proxy = createProxy();
    const { calls } = stubRoutes({});

    const capabilities = await proxy.detectCapabilities(BASE_URL, undefined, 5_000);

    expect(capabilities.templateReasoningEffortSupported).toBe(false);
    expect(capabilities.reasoningEffortSupported).toBe(false);
    expect(capabilities.notes.join('\n')).toMatch(/does not expose \/props/);
    expect(calls).toEqual(['http://127.0.0.1:9999/props', 'http://127.0.0.1:9999/v1/props']);
  });

  it('never claims a capability from a malformed or failing props response', async () => {
    const proxy = createProxy();
    const broken = vi.fn(async () => new Response('<html>not json</html>', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', broken);

    const capabilities = await proxy.detectCapabilities(BASE_URL, undefined, 5_000);

    expect(capabilities.templateReasoningEffortSupported).toBe(false);
    expect(capabilities.notes.join('\n')).toMatch(/Capability detection failed/);
  });

  it('sends the thinking level end to end once the root probe confirmed the template', async () => {
    const proxy = createProxy();
    stubRoutes({ '/props': { status: 200, body: LLAMA_PROPS } });

    const capabilities = await proxy.detectCapabilities(BASE_URL, undefined, 5_000);
    expect(capabilities.templateReasoningEffortSupported).toBe(true);

    // The catalog entry of the concrete model supplies the level whitelist;
    // buildUpstreamBody is the code path a chat request really takes.
    const params = { maxTokens: 64, temperature: 1.0, topP: 0.95, stream: false };
    for (const level of ['none', 'low', 'high'] as const) {
      const body = proxy.buildUpstreamBody(
        'Spark-X2.6-4B',
        [{ role: 'user', content: 'hi' }],
        { ...params, reasoningEffort: level },
        capabilities,
      );
      expect(body.reasoning_effort).toBe(level);
    }
    const rejected = proxy.buildUpstreamBody(
      'Spark-X2.6-4B',
      [{ role: 'user', content: 'hi' }],
      { ...params, reasoningEffort: 'medium' },
      capabilities,
    );
    expect(rejected.reasoning_effort).toBeUndefined();
  });
});

describe('the destination policy of the proxy against literal addresses', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const REFUSED_BASE_URLS = [
    'http://169.254.169.254',
    'http://169.254.169.254/v1',
    'http://169.254.1.2/v1',
    'http://100.100.100.200/v1',
    'http://[::ffff:169.254.169.254]/v1',
    'http://[::ffff:a9fe:a9fe]/v1',
    'http://[fe80::1]/v1',
    'http://[fd00:ec2::254]/v1',
  ];

  it.each(REFUSED_BASE_URLS)('refuses %s before any outbound request in the default configuration', async (baseUrl) => {
    const proxy = createProxy();
    const { calls } = createFetchStub();

    const error = await proxy.listModels({ baseUrl }, 2_000).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/link-local or cloud-metadata/);
    // The security assertion is the missing side effect: no request left.
    expect(calls).toHaveLength(0);
  });

  it('refuses a literal metadata address even when it is on the allow list', async () => {
    const config = loadServerConfig({ KAGGLE_KIT_ALLOWED_HOSTS: '169.254.169.254' }, process.cwd());
    const store = new SecretStore(path.join(os.tmpdir(), `kaggle-kit-proxy-allow-${Date.now()}.json`));
    const logger = createLogger({ sink: () => undefined });
    const calls: string[] = [];
    const stub = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);
    const proxy = new ProxyService(config, store, logger, (input, init) => globalThis.fetch(input, init));

    const error = await proxy.listModels({ baseUrl: 'http://169.254.169.254/v1' }, 2_000).catch((caught: unknown) => caught);

    expect((error as Error).message).toMatch(/link-local or cloud-metadata/);
    expect(calls).toHaveLength(0);
  });

  it('keeps a literal loopback endpoint working in the default configuration', async () => {
    const proxy = createProxy();
    const { calls } = createFetchStub();

    const error = await proxy.listModels({ baseUrl: 'http://127.0.0.1:9999/v1' }, 2_000).catch((caught: unknown) => caught);

    // The stub answers 404 to /v1/models; the point is that the policy let
    // the loopback destination through to the transport.
    expect((error as Error).message).toMatch(/not found/i);
    expect(calls).toEqual(['http://127.0.0.1:9999/v1/models']);
  });
});

describe('the proxy caps non-streaming upstream responses', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function proxyWithCompletionBody(bodyText: string) {
    const config = loadServerConfig({}, process.cwd());
    const store = new SecretStore(path.join(os.tmpdir(), `kaggle-kit-proxy-${Date.now()}.json`));
    const logger = createLogger({ sink: () => undefined });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/chat/completions')) {
        return new Response(bodyText, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    return new ProxyService(config, store, logger, (input, init) => globalThis.fetch(input, init));
  }

  const OVERSIZED_9MIB = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x'.repeat(9 * 1024 * 1024) } }] });

  it('rejects a non-streaming completion whose body exceeds the response limit instead of buffering it without bound', async () => {
    const proxy = proxyWithCompletionBody(OVERSIZED_9MIB);
    const client = proxy.createClient('http://127.0.0.1:9999/v1', 'k', 30_000);

    const error = await client.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);

    expect((error as { kind?: string }).kind).toBe('invalid_response');
    expect((error as Error).message).toMatch(/exceeded the .*response limit/i);
  });

  it('still delivers a large-but-legal completion below the limit', async () => {
    // 4 MiB of content is far below the 8 MiB limit and must pass through.
    const big = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x'.repeat(4 * 1024 * 1024) } }] });
    const proxy = proxyWithCompletionBody(big);
    const client = proxy.createClient('http://127.0.0.1:9999/v1', 'k', 30_000);

    const result = await client.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.choices?.[0]?.message?.content).toHaveLength(4 * 1024 * 1024);
  });

  it('clamps a caller-provided limit above the hard maximum instead of removing it', async () => {
    // The documented contract: callers may tighten the limit, never remove or
    // raise it. A "limit" of MAX_SAFE_INTEGER must not disable the cap.
    const proxy = proxyWithCompletionBody(OVERSIZED_9MIB);
    const client = proxy.createClient('http://127.0.0.1:9999/v1', 'k', 30_000, Number.MAX_SAFE_INTEGER);

    const error = await client.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);

    expect((error as { kind?: string }).kind).toBe('invalid_response');
    expect((error as Error).message).toMatch(/exceeded the .*response limit/i);
  });

  it('still lets callers tighten the limit below the hard maximum', async () => {
    // A 1 MiB caller limit must reject a 2 MiB body (tightening preserved)…
    const big = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024) } }] });
    const proxy = proxyWithCompletionBody(big);
    const client = proxy.createClient('http://127.0.0.1:9999/v1', 'k', 30_000, 1024 * 1024);
    const error = await client.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);
    expect((error as { kind?: string }).kind).toBe('invalid_response');

    // …while a 512 KiB body still passes the same 1 MiB limit.
    const small = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x'.repeat(512 * 1024) } }] });
    const proxy2 = proxyWithCompletionBody(small);
    const client2 = proxy2.createClient('http://127.0.0.1:9999/v1', 'k', 30_000, 1024 * 1024);
    const result = await client2.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.choices?.[0]?.message?.content).toHaveLength(512 * 1024);
  });

  it('treats the hard maximum as inclusive: exactly 8 MiB passes, one byte more is rejected', async () => {
    // The JSON wrapper around the content has a fixed overhead; measure it
    // instead of hard-coding it.
    const wrapper = (content: string) => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
    const overhead = wrapper('').length;

    const exactly = proxyWithCompletionBody(wrapper('x'.repeat(8 * 1024 * 1024 - overhead)));
    const clientExactly = exactly.createClient('http://127.0.0.1:9999/v1', 'k', 30_000);
    const ok = await clientExactly.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(ok.choices?.[0]?.message?.content).toHaveLength(8 * 1024 * 1024 - overhead);

    const beyond = proxyWithCompletionBody(wrapper('x'.repeat(8 * 1024 * 1024 - overhead + 1)));
    const clientBeyond = beyond.createClient('http://127.0.0.1:9999/v1', 'k', 30_000);
    const error = await clientBeyond.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);
    expect((error as { kind?: string }).kind).toBe('invalid_response');
  });

  it('applies the hard maximum when the limit argument is null (runtime, not just undefined)', async () => {
    const proxy = proxyWithCompletionBody(OVERSIZED_9MIB);
    const client = proxy.createClient('http://127.0.0.1:9999/v1', 'k', 30_000, null as unknown as number);

    const error = await client.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);

    expect((error as { kind?: string }).kind).toBe('invalid_response');
  });
});


describe('F6 - the connection test records whether a credential was exercised', () => {
  const connectionStub = () => vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (new URL(url).pathname === '/props') {
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({
        id: 'c', model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is true when the request carried an API key', async () => {
    vi.stubGlobal('fetch', connectionStub());
    const result = await createProxy().testConnection(
      { baseUrl: BASE_URL, apiKey: 'key-a' }, { model: 'm', timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.credentialUsed).toBe(true);
    expect(result.stages.find((stage) => stage.stage === 'auth')?.message).toMatch(/accepted the API key/i);
  });

  it('is false for a keyless endpoint even though the auth stage says ok', async () => {
    vi.stubGlobal('fetch', connectionStub());
    const result = await createProxy().testConnection(
      { baseUrl: BASE_URL }, { model: 'm', timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.credentialUsed).toBe(false);
    expect(result.stages.find((stage) => stage.stage === 'auth')?.status).toBe('ok');
    expect(result.stages.find((stage) => stage.stage === 'auth')?.message).toMatch(/without an API key/i);
  });
});
