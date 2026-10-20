import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app';
import { loadServerConfig, type ServerConfig } from './config';
import { createLogger } from './logger';
import { DEFAULT_TOOL_PROFILE_SETTINGS } from '../shared/tools/types';

const API_KEY = 'test-api-key-do-not-log';

interface MockUpstream {
  url: string;
  requests: { path: string; authorization: string | undefined; body: string }[];
}

/** A minimal OpenAI-compatible server used as the upstream of the proxy. */
function startMockUpstream(): Promise<MockUpstream> {
  const requests: MockUpstream['requests'] = [];

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      });

      const authorized = request.headers.authorization === `Bearer ${API_KEY}`;

      if (!authorized) {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }

      if (request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
        return;
      }

      if (request.url === '/props') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ default_generation_settings: { n_predict: -1 } }));
        return;
      }

      if (request.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body || '{}') as { stream?: boolean; model?: string };

        if (parsed.model === 'broken-model') {
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'the model crashed' } }));
          return;
        }

        if (parsed.stream) {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          response.write('data: {"choices":[{"delta":{"content":"O"}}]}\n\n');
          response.write('data: {"choices":[{"delta":{"content":"K"}}]}\n\n');
          response.write('data: [DONE]\n\n');
          response.end();
          return;
        }

        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: 1,
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'OK' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        );
        return;
      }

      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/v1`, requests });
    });
  });
}

describe('the local proxy backend', () => {
  let upstream: MockUpstream;
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  let logLines: string[];

  beforeAll(async () => {
    upstream = await startMockUpstream();

    const dataDir = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), 'kaggle-kit-test-')),
    );

    const config: ServerConfig = {
      ...loadServerConfig({}, process.cwd()),
      dataDir,
      secretsFile: path.join(dataDir, 'secrets.json'),
      clientDir: path.join(dataDir, 'client'),
      allowedHosts: null,
    };

    logLines = [];
    app = createApp({
      config,
      logger: createLogger({ sink: (line) => logLines.push(line) }),
    });

    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  });

  const post = (route: string, body: unknown) =>
    fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers the health check', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });

  it('lists the models of the upstream server', async () => {
    const response = await post('/api/proxy/models', {
      baseUrl: upstream.url,
      apiKey: API_KEY,
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { models: string[] };
    expect(payload.models).toEqual(['mock-model']);
  });

  it('reports an authentication failure without leaking the key', async () => {
    const response = await post('/api/proxy/models', {
      baseUrl: upstream.url,
      apiKey: 'wrong-key',
    });

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('invalid api key');
    expect(text).not.toContain('wrong-key');
  });

  it('runs a full connection test with a real inference request', async () => {
    const response = await post('/api/proxy/test', {
      baseUrl: upstream.url,
      apiKey: API_KEY,
      timeoutMs: 10_000,
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      modelId: string;
      baseUrlChanged: boolean;
      testedAt: string;
      stages: { stage: string; status: string }[];
    };

    expect(payload.ok).toBe(true);
    expect(payload.modelId).toBe('mock-model');
    expect(payload.stages.map((stage) => stage.stage)).toEqual([
      'transport',
      'auth',
      'models',
      'model',
      'inference',
      'streaming',
    ]);
    expect(payload.stages.find((stage) => stage.stage === 'transport')?.status).toBe('ok');
    expect(payload.stages.find((stage) => stage.stage === 'auth')?.status).toBe('ok');
    expect(payload.stages.find((stage) => stage.stage === 'models')?.status).toBe('ok');
    expect(payload.stages.find((stage) => stage.stage === 'model')?.status).toBe('ok');
    expect(payload.stages.find((stage) => stage.stage === 'inference')?.status).toBe('ok');
    // An HTTP 200 of the model list never implies that streaming works.
    expect(payload.stages.find((stage) => stage.stage === 'streaming')?.status).toBe('not_run');
    expect(payload.baseUrlChanged).toBe(false);
    expect(payload.testedAt).toBeTruthy();
  });

  it('does not report a connection as working when the real inference fails', async () => {
    const response = await post('/api/proxy/test', {
      baseUrl: upstream.url,
      apiKey: API_KEY,
      model: 'broken-model',
      timeoutMs: 10_000,
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      errorKind: string;
      stages: { stage: string; status: string }[];
    };

    expect(payload.ok).toBe(false);
    expect(payload.errorKind).toBe('server');
    expect(payload.stages.find((stage) => stage.stage === 'models')?.status).toBe('ok');
    expect(payload.stages.find((stage) => stage.stage === 'inference')?.status).toBe('failed');
    expect(payload.stages.find((stage) => stage.stage === 'streaming')?.status).toBe('not_run');
  });

  it('uses the first reported model when the profile has no model ID', async () => {
    const response = await post('/api/proxy/chat', {
      baseUrl: upstream.url,
      apiKey: API_KEY,
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
      params: { maxTokens: 16, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });

    expect(response.status).toBe(200);
    const last = upstream.requests[upstream.requests.length - 1];
    const sent = JSON.parse(last?.body ?? '{}') as { model?: string };
    expect(sent.model).toBe('mock-model');
  });

  it('proxies a chat completion', async () => {
    const response = await post('/api/proxy/chat', {
      baseUrl: upstream.url,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      params: { maxTokens: 24, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      response: { choices: { message: { content: string } }[]; usage?: { total_tokens?: number } };
    };
    expect(payload.response.choices[0]?.message.content).toBe('OK');
    expect(payload.response.usage?.total_tokens).toBe(7);
  });

  it('never sends unsupported parameters upstream', async () => {
    await post('/api/proxy/chat', {
      baseUrl: upstream.url,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      params: { maxTokens: 16, temperature: 0, topP: 1, reasoningEffort: 'medium' },
      timeoutMs: 10_000,
    });

    const last = upstream.requests[upstream.requests.length - 1];
    const sent = JSON.parse(last?.body ?? '{}') as Record<string, unknown>;
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.frequency_penalty).toBeUndefined();
    expect(sent.stream).toBeUndefined();
  });

  it('stores a key in the server side secret store and uses it for requests', async () => {
    const save = await post('/api/secrets', { ref: 'ref-1', apiKey: API_KEY });
    expect(save.status).toBe(200);

    const list = await fetch(`${baseUrl}/api/secrets`);
    const listText = await list.text();
    const payload = JSON.parse(listText) as { references: string[] };
    expect(payload.references).toContain('ref-1');
    expect(listText).not.toContain(API_KEY);

    const response = await post('/api/proxy/models', {
      baseUrl: upstream.url,
      secretRef: 'ref-1',
    });
    expect(response.status).toBe(200);

    const remove = await fetch(`${baseUrl}/api/secrets/ref-1`, { method: 'DELETE' });
    expect(remove.status).toBe(200);
  });

  it('stores, reads, and deletes sanitized server-side tool settings', async () => {
    const directCredential = 'do-not-store-this-header-value';
    const settings = {
      ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
      enabled: true,
      allowedTools: ['http_public_search'],
      httpTools: [{
        id: 'public-search', name: 'Public search', description: 'Read public search data',
        endpoint: 'https://api.example.com/search', method: 'GET' as const,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        headers: [{ name: 'Authorization', value: directCredential }], permission: 'read_only' as const, timeoutMs: 5000,
      }],
    };
    const save = await fetch(`${baseUrl}/api/tools/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'tool-profile-1', settings }),
    });
    expect(save.status).toBe(200);
    const savedText = await save.text();
    expect(savedText).not.toContain(directCredential);
    const saved = JSON.parse(savedText) as { settings: { enabled: boolean; httpTools: Array<{ headers: unknown[] }> } };
    expect(saved.settings.enabled).toBe(true);
    expect(saved.settings.httpTools[0]?.headers).toEqual([]);
    expect((await app.store.getToolProfile('tool-profile-1'))?.httpTools[0]?.headers).toEqual([]);

    const disk = JSON.parse(await (await import('node:fs/promises')).readFile(app.store.path, 'utf8')) as Record<string, unknown>;
    expect(disk.version).toBe(2);
    expect(disk).toHaveProperty('secrets');
    expect(disk).toHaveProperty('toolProfiles');
    expect(JSON.stringify(disk)).not.toContain(directCredential);

    const read = await fetch(`${baseUrl}/api/tools/profile?profileId=tool-profile-1`);
    expect(read.status).toBe(200);
    expect((await read.json() as { settings: { enabled: boolean } }).settings.enabled).toBe(true);
    const remove = await fetch(`${baseUrl}/api/tools/profile?profileId=tool-profile-1`, { method: 'DELETE' });
    expect(remove.status).toBe(200);
    expect(await app.store.getToolProfile('tool-profile-1')).toBeNull();
  });

  it('rejects invalid tool profile identifiers and refuses a claimed native capability', async () => {
    const invalid = await fetch(`${baseUrl}/api/tools/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: '../bad', settings: DEFAULT_TOOL_PROFILE_SETTINGS }),
    });
    expect(invalid.status).toBe(400);

    const response = await post('/api/tools/capability', {
      baseUrl: upstream.url,
      apiKey: API_KEY,
      model: 'mock-model',
      timeoutMs: 10_000,
    });
    expect(response.status).toBe(200);
    const capability = await response.json() as { status: string; detail: string };
    expect(capability.status).toBe('failed_verification');
    expect(capability.detail).toMatch(/ordinary chat is unchanged|tool use remains disabled/i);
    const probe = upstream.requests[upstream.requests.length - 1];
    const sent = JSON.parse(probe?.body ?? '{}') as { tools?: Array<{ function?: { name?: string } }>; stream?: boolean };
    expect(sent.tools?.[0]?.function?.name).toBe('kaggle_kit_capability_probe');
    expect(sent.stream).toBe(false);
  });

  it('uploads only bounded extracted metadata and can remove a conversation vault', async () => {
    const upload = await post('/api/tools/files/upload', {
      conversationId: 'conversation-1',
      name: '../notes.txt',
      mediaType: 'text/plain',
      contentBase64: Buffer.from('untrusted file contents').toString('base64'),
    });
    expect(upload.status).toBe(201);
    const payload = await upload.json() as { file: { id: string; name: string; extractedCharacters: number } };
    expect(payload.file.name).toBe('notes.txt');
    expect(payload.file.extractedCharacters).toBeGreaterThan(0);
    expect(JSON.stringify(payload)).not.toContain('untrusted file contents');

    const listed = await fetch(`${baseUrl}/api/tools/files?conversationId=conversation-1`);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { files: Array<{ id: string }> }).files.map((file) => file.id)).toContain(payload.file.id);
    const invalid = await post('/api/tools/files/upload', {
      conversationId: 'conversation-1', name: 'bad.txt', mediaType: 'text/plain', contentBase64: '%%%not-base64%%%',
    });
    expect(invalid.status).toBe(400);

    const remove = await fetch(`${baseUrl}/api/tools/files?conversationId=conversation-1`, { method: 'DELETE' });
    expect(remove.status).toBe(200);
    expect((await (await fetch(`${baseUrl}/api/tools/files?conversationId=conversation-1`)).json() as { files: unknown[] }).files).toEqual([]);
  });

  it('rejects an unknown endpoint', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(response.status).toBe(404);
  });

  it('rejects a request without a base URL', async () => {
    const response = await post('/api/proxy/models', {});
    expect(response.status).toBe(400);
  });

  it('never writes the API key into the logs', async () => {
    await post('/api/proxy/models', { baseUrl: upstream.url, apiKey: API_KEY });
    expect(logLines.join('\n')).not.toContain(API_KEY);
  });

  it('verifies streaming support with a real event stream', async () => {
    const response = await post('/api/proxy/probe-stream', {
      baseUrl: upstream.url,
      apiKey: API_KEY,
      model: 'mock-model',
      timeoutMs: 10_000,
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { supported: boolean; detail: string };
    expect(payload.supported).toBe(true);
  });
});
