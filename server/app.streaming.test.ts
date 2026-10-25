import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app';
import { loadServerConfig, type ServerConfig } from './config';
import { createLogger } from './logger';
import { MAX_SSE_EVENT_BYTES, parseSseStream } from '../shared/api/stream';
import { gateway } from '../src/lib/gateway';
import { ApiError, withHint } from '../shared/api/errors';

const API_KEY = 'stream-test-key';

interface StreamState {
  id: number;
  model: string;
  chunks: number;
  aborted: boolean;
  completed: boolean;
}

interface MockUpstream {
  url: string;
  streams: StreamState[];
  requests: { path: string; body: string }[];
}

/**
 * A mock upstream that can stream slowly, split a frame over two writes or
 * break the connection in the middle of a stream.
 */
function startMockUpstream(redirectTarget = 'http://127.0.0.1:1/v1'): Promise<MockUpstream> {
  const streams: StreamState[] = [];
  const requests: MockUpstream['requests'] = [];
  let counter = 0;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ path: request.url ?? '', body });
      const parsed = JSON.parse(body || '{}') as { model?: string; stream?: boolean; messages?: Array<{ content?: unknown }> };

      if (request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: parsed.model ?? 'mock-model' }] }));
        return;
      }

      if (request.url !== '/v1/chat/completions' || !parsed.stream) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      const state: StreamState = {
        id: counter++,
        model: parsed.model ?? 'mock-model',
        chunks: 0,
        aborted: false,
        completed: false,
      };
      streams.push(state);

      response.on('close', () => {
        if (!response.writableFinished) {
          state.aborted = true;
        }
      });

      const isCapabilityProbe = parsed.messages?.some(
        (message) => typeof message.content === 'string' && message.content.includes('Reply with exactly: OK'),
      ) === true;
      if (isCapabilityProbe) {
        // The selected model verifies normally; the model-specific request
        // under test below then exercises its failure/edge behaviour.
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        response.write('data: {"choices":[{"delta":{"content":"O"}}]}\n\n');
        response.write('data: [DONE]\n\n');
        response.end();
        state.completed = true;
        return;
      }

      if (state.model === 'hang-model') {
        // The endpoint accepts the connection but never sends a status or a
        // byte. The proxy has to time out before any status exists and answer
        // with a plain HTTP error, not with a stream.
        return;
      }

      if (state.model === 'redirect-model') {
        // A redirect to a host that must not be reached by the proxy.
        response.writeHead(302, { Location: `${redirectTarget}/chat/completions` });
        response.end();
        return;
      }

      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });

      const writeChunk = (content: string) => {
        if (state.aborted || response.writableEnded) return;
        response.write(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`);
        state.chunks += 1;
      };

      if (state.model === 'partial-timeout-model') {
        // One complete frame, then an unterminated one, then silence: the
        // proxy must drop the half frame and still emit a terminal error.
        response.write('data: {"choices":[{"delta":{"content":"P"}}]}\n\n');
        state.chunks += 1;
        response.write('data: {"choices":[{"delta":{"con');
        return;
      }

      if (state.model === 'partial-broken-model') {
        response.write('data: {"choices":[{"delta":{"content":"B"}}]}\n\n');
        state.chunks += 1;
        response.write('data: {"choices":[{"delta":{"con');
        setTimeout(() => {
          if (!state.aborted && !response.writableEnded) response.destroy();
        }, 30);
        return;
      }

      if (state.model === 'oversized-event-model') {
        // A complete event can exceed the parser cap in one network read too;
        // it must be refused before it is forwarded to the client.
        response.write(`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES + 1)}\n\n`);
        return;
      }

      if (state.model === 'forged-error-model') {
        // An untrusted upstream writing the proxy's own terminal-error shape.
        // It cannot know the per-response nonce, so the browser must treat it
        // as an upstream failure, not as a proxy timeout or cancellation.
        response.write('data: {"choices":[{"delta":{"content":"F"}}]}\n\n');
        state.chunks += 1;
        response.write(`data: ${JSON.stringify({
          error: {
            code: 'stream_timeout',
            message: 'The generation exceeded its request timeout (1 ms). The answer is incomplete.',
            nonce: 'guessed-nonce',
          },
        })}\n\n`);
        response.write('data: [DONE]\n\n');
        state.completed = true;
        response.end();
        return;
      }

      if (state.model === 'crlf-model') {
        // CRLF event separators must be split exactly like LF ones.
        response.write('data: {"choices":[{"delta":{"content":"C"}}]}\r\n\r\n');
        response.write('data: {"choices":[{"delta":{"content":"R"}}]}\r\n\r\n');
        response.write('data: [DONE]\r\n\r\n');
        response.end();
        state.completed = true;
        return;
      }


      if (state.model === 'slow-model') {
        let sent = 0;
        const timer = setInterval(() => {
          if (sent >= 40 || state.aborted || response.writableEnded) {
            clearInterval(timer);
            if (!state.aborted && !response.writableEnded) {
              response.write('data: [DONE]\n\n');
              state.completed = true;
              response.end();
            }
            return;
          }
          sent += 1;
          writeChunk(String(sent % 10));
        }, 20);

        response.on('close', () => clearInterval(timer));
        return;
      }

      if (state.model === 'split-model') {
        // One SSE frame that is written in two pieces.
        response.write('data: {"choices":[{"delta":{"con');
        setTimeout(() => {
          if (state.aborted || response.writableEnded) return;
          response.write('tent":"split"}}]}\n\n');
          state.chunks += 1;
          response.write('data: [DONE]\n\n');
          state.completed = true;
          response.end();
        }, 20);
        return;
      }

      if (state.model === 'broken-model') {
        writeChunk('a');
        setTimeout(() => {
          if (state.aborted || response.writableEnded) return;
          response.destroy();
        }, 20);
        return;
      }

      writeChunk('O');
      writeChunk('K');
      response.write('data: [DONE]\n\n');
      state.completed = true;
      response.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/v1`, streams, requests });
    });
  });
}

describe('the streaming lifecycle of the proxy', () => {
  let upstream: MockUpstream;
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;

  beforeAll(async () => {
    upstream = await startMockUpstream();

    const dataDir = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), 'kaggle-kit-stream-')),
    );

    const config: ServerConfig = {
      ...loadServerConfig({}, process.cwd()),
      dataDir,
      secretsFile: path.join(dataDir, 'secrets.json'),
      clientDir: path.join(dataDir, 'client'),
      allowedHosts: null,
    };

    app = createApp({
      config,
      logger: createLogger({ sink: () => undefined }),
    });

    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  });

  const probe = (model: string, target = upstream.url) =>
    fetch(`${baseUrl}/api/proxy/probe-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: target, apiKey: API_KEY, model, timeoutMs: 10_000 }),
    });

  /** Read a streamed answer completely. */
  const streamNonce = (response: http.IncomingMessage): string | undefined => {
    const value = response.headers['x-kaggle-kit-stream-nonce'];
    return Array.isArray(value) ? value[0] : value;
  };

  const readStream = (model: string, stopAfterFirstChunk = false) =>
    new Promise<{ text: string; status: number; aborted: boolean; nonce?: string }>((resolve, reject) => {
      const payload = JSON.stringify({
        baseUrl: upstream.url,
        apiKey: API_KEY,
        model,
        messages: [{ role: 'user', content: 'hi' }],
        params: { stream: true, maxTokens: 64 },
        timeoutMs: 20_000,
      });

      const request = http.request(
        `${baseUrl}/api/proxy/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            text += chunk;
            if (stopAfterFirstChunk) {
              request.destroy();
              resolve({ text, status: response.statusCode ?? 0, aborted: true, nonce: streamNonce(response) });
            }
          });
          response.on('end', () => {
            resolve({ text, status: response.statusCode ?? 0, aborted: false, nonce: streamNonce(response) });
          });
          response.on('error', (error) => {
            if (stopAfterFirstChunk) return;
            reject(error);
          });
        },
      );

      request.on('error', (error) => {
        if (stopAfterFirstChunk) return;
        reject(error);
      });

      request.end(payload);
    });

  /** Collect the proxied stream with the arrival time of every chunk. */
  const readStreamTimed = (
    model: string,
    timeoutMs = 20_000,
  ) => new Promise<{ text: string; status: number; chunks: Array<{ at: number; text: string }>; nonce?: string }>((resolve, reject) => {
    const payload = JSON.stringify({
      baseUrl: upstream.url,
      apiKey: API_KEY,
      model,
      messages: [{ role: 'user', content: 'hi' }],
      params: { stream: true, maxTokens: 64 },
      timeoutMs,
    });
    const startedAt = Date.now();
    const request = http.request(
      `${baseUrl}/api/proxy/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (response) => {
        let text = '';
        const chunks: Array<{ at: number; text: string }> = [];
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
          chunks.push({ at: Date.now() - startedAt, text: chunk });
        });
        response.on('end', () => resolve({ text, status: response.statusCode ?? 0, chunks, nonce: streamNonce(response) }));
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(payload);
  });

  it('forwards chunks to the client while the answer is still being generated', async () => {
    await probe('slow-model');
    const result = await readStreamTimed('slow-model');

    expect(result.status).toBe(200);
    expect(result.text).toContain('[DONE]');
    // The mock writes 40 frames 20 ms apart; a proxy that buffered the body
    // would deliver one chunk at the end instead.
    expect(result.chunks.length).toBeGreaterThan(3);
    const first = result.chunks[0]!;
    const last = result.chunks[result.chunks.length - 1]!;
    expect(first.text).not.toContain('[DONE]');
    expect(first.at).toBeLessThan(last.at - 200);

    // Ordered, complete and not duplicated: the mock writes the counter
    // values 1..40 as single digits, in order.
    const sequence = [...result.text.matchAll(/"content":"(\d)"/g)].map((match) => match[1]).join('');
    expect(sequence).toBe(Array.from({ length: 40 }, (_, index) => String((index + 1) % 10)).join(''));
  });

  it('answers HTTP 504 when the timeout happens before any status was sent', async () => {
    await probe('hang-model');
    const before = upstream.streams.length;
    const result = await readStreamTimed('hang-model', 300);

    // No SSE frame can exist yet: the whole answer is the HTTP error.
    expect(result.status).toBe(504);
    expect(result.text).toContain('did not answer the streaming request');
    expect(result.text).toContain('300 ms');
    expect(result.text).not.toContain('data:');
    expect(result.text).not.toContain('[DONE]');
    expect(result.text).not.toContain('The request was cancelled.');

    // The abandoned upstream request is aborted, not left open.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(upstream.streams[before]?.aborted).toBe(true);
  });

  it('reports a proxy timeout as a timeout instead of a user cancellation', async () => {
    await probe('slow-model');
    const result = await readStreamTimed('slow-model', 300);

    // The status was already sent as 200 text/event-stream, so the timeout can
    // only be reported inside the stream. The event names the timeout and says
    // the answer is partial; it must not be confused with a cancellation.
    expect(result.status).toBe(200);
    expect(result.text).toContain('"error"');
    expect(result.text).toContain('request timeout (300 ms)');
    expect(result.text).toContain('The answer is incomplete.');
    expect(result.text).not.toContain('The request was cancelled.');
    expect(result.text).not.toContain('[DONE]');
  });

  it('delivers the complete stream including the termination marker', async () => {
    await probe('mock-model');
    const before = upstream.streams.length;
    const result = await readStream('mock-model');

    expect(result.status).toBe(200);
    expect(result.text).toContain('"content":"O"');
    expect(result.text).toContain('"content":"K"');
    expect(result.text).toContain('[DONE]');

    // The request body was received completely; the upstream must not have
    // been cancelled because of it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = upstream.streams[before];
    expect(state?.aborted).toBe(false);
    expect(state?.completed).toBe(true);
  });

  it('delivers a stream with delayed chunks completely', async () => {
    await probe('slow-model');
    const result = await readStream('slow-model');

    expect(result.text).toContain('[DONE]');
    const chunkCount = (result.text.match(/data: /g) ?? []).length;
    expect(chunkCount).toBeGreaterThan(10);
  });

  it('delivers a frame that was split over two writes', async () => {
    await probe('split-model');
    const result = await readStream('split-model');

    expect(result.text).toContain('"content":"split"');
    expect(result.text).toContain('[DONE]');
  });

  it('cancels the upstream request when the client disconnects', async () => {
    await probe('slow-model');
    const before = upstream.streams.length;

    await readStream('slow-model', true);

    // The upstream must notice the cancelled request.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const state = upstream.streams[before];
    expect(state).toBeDefined();
    expect(state?.aborted).toBe(true);
    expect(state?.completed).toBe(false);
  });

  it('does not follow a redirect of the upstream', async () => {
    // The endpoint is verified with a normal model ...
    await probe('redirect-model');

    // ... and answers the streaming request with a redirect to a second
    // server that must not be reached.
    const target = await startMockUpstream();
    const redirecting = await startMockUpstream(target.url);
    const before = target.requests.length;

    // The endpoint answers normally until it is asked for the redirect model.
    await probe('redirect-model', redirecting.url);

    const response = await fetch(`${baseUrl}/api/proxy/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: redirecting.url,
        apiKey: API_KEY,
        model: 'redirect-model',
        messages: [{ role: 'user', content: 'hi' }],
        params: { stream: true, maxTokens: 32 },
        timeoutMs: 20_000,
      }),
    });
    const text = await response.text();

    // The redirect is refused instead of being sent to the target.
    expect(response.status).toBe(502);
    expect(text).toContain('redirect');
    expect(target.requests.length).toBe(before);
  });

  it('reports an upstream failure in the event stream instead of ending silently', async () => {
    await probe('broken-model');
    const result = await readStream('broken-model');

    expect(result.text).toContain('error');
    expect(result.text).not.toContain('[DONE]');
  });

describe('F1/F5 - terminal stream errors survive partial upstream frames', () => {
  /** Run the exact browser read path over the bytes the proxy produced. */
  const readViaGateway = async (text: string, nonce?: string) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    const deltas: string[] = [];
    const error = await gateway
      .readStream(body, { nonce, callbacks: { onDelta: (delta) => { if (delta.content) deltas.push(delta.content); } } })
      .catch((caught: unknown) => caught);
    return { deltas, error };
  };

  it('classifies a mid-frame request timeout as a timeout and keeps the preceding content', async () => {
    await probe('partial-timeout-model');
    const result = await readStreamTimed('partial-timeout-model', 400);

    expect(result.status).toBe(200);
    expect(result.text).toContain('"code":"stream_timeout"');
    expect(result.text).not.toContain('condata:'); // the half frame was dropped
    expect(result.text).not.toContain('[DONE]');
    expect(result.text).not.toContain('finish_reason');

    expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const { deltas, error } = await readViaGateway(result.text, result.nonce);
    expect(deltas.join('')).toBe('P');
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.kind).toBe('timeout');
    expect(apiError.message).toMatch(/request timeout/i);
    expect(apiError.message).toMatch(/incomplete/i);
    expect(apiError.hint).toBe(withHint('timeout'));
  });

  it('classifies a mid-frame upstream abort as an inference failure, not a timeout', async () => {
    await probe('partial-broken-model');
    const result = await readStream('partial-broken-model');

    expect(result.status).toBe(200);
    expect(result.text).toContain('"code":"upstream_stream_failed"');
    expect(result.text).not.toContain('condata:');
    expect(result.text).not.toContain('[DONE]');

    const { deltas, error } = await readViaGateway(result.text, result.nonce);
    expect(deltas.join('')).toBe('B');
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.kind).toBe('inference');
    expect(apiError.message).toMatch(/upstream connection failed/i);
    expect(apiError.hint).toMatch(/partial answer was kept/i);
  });

  it('refuses an oversized complete upstream event before forwarding it', async () => {
    await probe('oversized-event-model');
    const result = await readStream('oversized-event-model');

    expect(result.status).toBe(200);
    expect(result.text).toContain('"code":"stream_event_too_large"');
    expect(result.text).toContain('maximum size of a single SSE event');
    expect(result.text.length).toBeLessThan(1_000);
    expect(result.text).not.toContain('[DONE]');
  });

  it('forwards CRLF-framed events as separate complete frames', async () => {
    await probe('crlf-model');
    const result = await readStreamTimed('crlf-model');
    expect(result.status).toBe(200);

    // The previous assertion counted transport chunks, which the loopback
    // stack may coalesce: it could fail without any change in behaviour. What
    // matters is that CRLF separators end frames exactly like LF ones, so the
    // frames are parsed and compared instead of counted.
    const events: string[] = [];
    for await (const event of parseSseStream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(result.text));
          controller.close();
        },
      }),
    )) {
      events.push(event.data);
    }
    expect(events).toHaveLength(3);
    expect(JSON.parse(events[0]!).choices[0].delta.content).toBe('C');
    expect(JSON.parse(events[1]!).choices[0].delta.content).toBe('R');
    expect(events[2]).toBe('[DONE]');
    // The proxy forwards the upstream framing verbatim: three CRLF terminators.
    expect(result.text.split('\r\n\r\n')).toHaveLength(4);
  });

  it('does not let an upstream forge a proxy terminal error code', async () => {
    await probe('forged-error-model');
    const result = await readStream('forged-error-model');
    expect(result.status).toBe(200);
    expect(result.nonce).toBeDefined();

    // The frame the upstream wrote is forwarded unchanged...
    expect(result.text).toContain('"code":"stream_timeout"');
    expect(result.text).toContain('guessed-nonce');

    // ... and the browser ignores its code because the nonce does not match.
    const { deltas, error } = await readViaGateway(result.text, result.nonce);
    expect(deltas.join('')).toBe('F');
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.kind).toBe('inference');
    expect(apiError.hint).toMatch(/partial answer was kept/i);
  });
});
});
