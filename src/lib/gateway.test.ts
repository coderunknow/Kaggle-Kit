import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../shared/api/errors';
import { gateway } from './gateway';

function eventStream(chunks: string[], options: { close?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (options.close) {
        controller.close();
        return;
      }
      // The stream stays open, like a running generation.
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const REQUEST = {
  baseUrl: 'http://127.0.0.1:8000/v1',
  model: 'mock-model',
  messages: [{ role: 'user' as const, content: 'hello' }],
  params: { stream: true, maxTokens: 32, temperature: 0, topP: 1 },
};

describe('the browser gateway', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a complete event stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        eventStream(
          [
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
            'data: [DONE]\n\n',
          ],
          { close: true },
        ),
      ),
    );

    const result = await gateway.chat(REQUEST);

    expect(result.streamed).toBe(true);
    expect(result.content).toBe('Hello');
    expect(result.finishReason).toBe('stop');
  });

  it('reports a cancelled stream as cancelled and not as a finished answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => eventStream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'])),
    );

    const controller = new AbortController();
    const promise = gateway.chat(REQUEST, { signal: controller.signal });
    controller.abort();

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('aborted');
  });

  it('reports a failing proxy with the reason of the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'boom', kind: 'server' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const error = await gateway.chat(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('server');
    expect((error as ApiError).message).toBe('boom');
  });

  it('never places the key in the request URL', async () => {
    const fetchMock = vi.fn(async () => eventStream(['data: [DONE]\n\n'], { close: true }));
    vi.stubGlobal('fetch', fetchMock);

    await gateway.chat({ ...REQUEST, apiKey: 'secret-key' });

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).not.toContain('secret-key');
    expect(call[0].startsWith('/api/')).toBe(true);
  });
});
