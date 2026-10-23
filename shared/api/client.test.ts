import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './errors';
import { OpenAIClient } from './client';

const API_KEY = 'super-secret-key-value';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('OpenAIClient', () => {
  it('sends the API key in the Authorization header only', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'model-a' }] }));
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', apiKey: API_KEY, fetchImpl });

    await client.listModels();

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/v1/models');
    expect(url).not.toContain(API_KEY);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('omits the Authorization header when no key is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

    await client.listModels();

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('never places the key in the request URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', apiKey: API_KEY, fetchImpl });

    await client.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(API_KEY);
    expect(String(init.body)).not.toContain(API_KEY);
  });

  it('classifies 401 as an authentication error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'invalid api key' } }, 401));
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', apiKey: API_KEY, fetchImpl });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('auth');
    expect((error as ApiError).httpStatus).toBe(401);
  });

  it('classifies 404 as not found', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'no route' }, 404));
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect((error as ApiError).kind).toBe('not_found');
  });

  it('classifies 500 as a server error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect((error as ApiError).kind).toBe('server');
  });

  it('reports invalid JSON as an invalid response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>nope</html>', { status: 200 }));
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect((error as ApiError).kind).toBe('invalid_response');
  });

  it('stops reading a response when a configured byte limit is exceeded', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":[] }'));
          controller.enqueue(new TextEncoder().encode(' '.repeat(1024)));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl, maxResponseBytes: 16 });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('invalid_response');
    expect((error as ApiError).message).toContain('16-byte response limit');
    expect(cancelled).toBe(true);
  });

  it('reports an empty body as an invalid response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect((error as ApiError).kind).toBe('invalid_response');
  });

  it('reports a network failure as blocked by CORS or proxy', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect((error as ApiError).kind).toBe('cors_or_proxy');
  });

  it('reports a timeout when the request exceeds the timeout', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl, timeoutMs: 20 });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect((error as ApiError).kind).toBe('timeout');
  });

  it('keeps the timeout active while the response body is being read', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl, timeoutMs: 20 });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect((error as ApiError).kind).toBe('timeout');
  });

  it('reports an external abort as cancelled', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl, timeoutMs: 5_000 });

    const promise = client.listModels({ signal: controller.signal });
    controller.abort();

    const error = await promise.catch((caught: unknown) => caught);
    expect((error as ApiError).kind).toBe('aborted');
  });

  it('redacts the API key from error messages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: `bad key ${API_KEY}` } }, 401));
    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', apiKey: API_KEY, fetchImpl });

    const error = (await client.listModels().catch((caught: unknown) => caught)) as ApiError;
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('[redacted]');
  });

  it('rejects an empty API key', () => {
    expect(() => new OpenAIClient({ baseUrl: 'https://example.com', apiKey: '   ' })).toThrow(ApiError);
  });

  it('rejects an invalid response byte limit instead of silently disabling the cap', () => {
    expect(() => new OpenAIClient({ baseUrl: 'https://example.com', maxResponseBytes: 0 })).toThrow(ApiError);
    expect(() => new OpenAIClient({ baseUrl: 'https://example.com', maxResponseBytes: 1.5 })).toThrow(ApiError);
  });

  describe('props endpoint discovery', () => {
    const PROPS_PAYLOAD = {
      default_generation_settings: { n_predict: -1 },
      chat_template_caps: { supports_reasoning_effort: true },
    };

    it('probes the server-root /props like llama.cpp does and never touches /v1/props on success', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(PROPS_PAYLOAD));
      const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

      await expect(client.props()).resolves.toEqual(PROPS_PAYLOAD);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://example.com/props');
    });

    it('falls back to /v1/props when the root endpoint does not exist', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: { message: 'not found' } }, 404))
        .mockResolvedValueOnce(jsonResponse(PROPS_PAYLOAD));
      const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

      await expect(client.props()).resolves.toEqual(PROPS_PAYLOAD);
      expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
        'https://example.com/props',
        'https://example.com/v1/props',
      ]);
    });

    it('returns null from props() when neither endpoint exists', async () => {
      // A fresh Response per call, exactly like a real transport: one
      // Response instance cannot be read twice.
      const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse({ error: 'not found' }, 404));
      const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

      await expect(client.props()).resolves.toBeNull();
      expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
        'https://example.com/props',
        'https://example.com/v1/props',
      ]);
    });

    it('propagates a server error instead of reporting a missing endpoint', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
      const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

      const error = await client.props().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).kind).toBe('server');
      // A failing server is not "no /props": the fallback is only for absent
      // endpoints, so no second request is invented.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('propagates a malformed JSON body as invalid_response', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response('not json at all', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });

      const error = await client.props().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).kind).toBe('invalid_response');
    });

    it('keeps a reverse-proxy path prefix and normalizes a trailing slash', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(PROPS_PAYLOAD));
      const client = new OpenAIClient({ baseUrl: 'https://gw.example.com/llama/v1/', fetchImpl });

      await expect(client.props()).resolves.toEqual(PROPS_PAYLOAD);
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://gw.example.com/llama/props');
    });

    it('sends the API key on the root probe and never contacts another host', async () => {
      const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse({ error: 'not found' }, 404));
      const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', apiKey: API_KEY, fetchImpl });

      await expect(client.props()).resolves.toBeNull();
      for (const call of fetchImpl.mock.calls) {
        const [url, init] = call as [string, RequestInit];
        expect(new URL(url).origin).toBe('https://example.com');
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
      }
    });
  });

  it('follows a redirect to the same origin', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://example.com/v1/models' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'model-a' }] }));

    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', apiKey: API_KEY, fetchImpl });
    const result = await client.listModels();

    expect(result.models).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://example.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.redirect).toBe('manual');
  });

  it('refuses a redirect to another origin when an API key is set', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://evil.test/v1/models' } }),
      );

    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', apiKey: API_KEY, fetchImpl });
    const error = await client.listModels().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('bad_request');
    expect((error as ApiError).message).not.toContain(API_KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect that the caller does not allow', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://other.test/v1/models' } }),
      );

    const client = new OpenAIClient({
      baseUrl: 'https://example.com/v1',
      fetchImpl,
      validateRedirect: (target) => new URL(target).host === 'example.com',
    });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('allow list');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after too many redirects', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://example.com/v1/models' } }),
      );

    const client = new OpenAIClient({
      baseUrl: 'https://example.com/v1',
      fetchImpl,
      maxRedirects: 2,
    });

    const error = await client.listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toMatch(/redirected too many times/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('turns a redirect of a POST request into a GET without a body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 303, headers: { Location: 'https://example.com/v1/models' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = new OpenAIClient({ baseUrl: 'https://example.com/v1', fetchImpl });
    await client.request('/chat/completions', { method: 'POST', body: '{}' });

    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

});
