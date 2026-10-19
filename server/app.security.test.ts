import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app';
import { loadServerConfig, type ServerConfig } from './config';
import { createLogger } from './logger';

describe('the request policy of the local proxy backend', () => {
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  let clientDir: string;

  beforeAll(async () => {
    const fs = await import('node:fs/promises');
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaggle-kit-security-'));
    clientDir = path.join(dataDir, 'client');
    await fs.mkdir(path.join(clientDir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(clientDir, 'index.html'), '<!doctype html><title>app</title>');
    await fs.writeFile(path.join(clientDir, 'assets', 'app.js'), 'console.log(1);');
    await fs.writeFile(path.join(dataDir, 'secret.txt'), 'top secret');

    const config: ServerConfig = {
      ...loadServerConfig({}, process.cwd()),
      dataDir,
      secretsFile: path.join(dataDir, 'secrets.json'),
      clientDir,
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

  /**
   * Send a request with the path exactly as it is written.
   *
   * `fetch` normalises the path before it is sent, so the traversal has to
   * be sent with a raw request to reach the server.
   */
  const rawStatus = (requestPath: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: new URL(baseUrl).port, path: requestPath, method: 'GET' },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', reject);
      request.end();
    });

  afterAll(async () => {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  });

  it('serves the client of the application', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>app</title>');
  });

  it('serves an asset of the client', async () => {
    const response = await fetch(`${baseUrl}/assets/app.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('console.log');
  });

  it('refuses a path that leaves the client directory', async () => {
    // The slashes are encoded, so the URL parser keeps the ".." segment and
    // the path reaches the file resolution of the server.
    const status = await rawStatus('/%2e%2e%2fsecret.txt');
    expect(status).toBe(403);
  });

  it('refuses a path with a traversal in the middle', async () => {
    const status = await rawStatus('/assets%2f..%2f..%2fsecret.txt');
    expect(status).toBe(403);
  });

  it('refuses a path that resolves to a sibling directory', async () => {
    // "client-secret" starts with "client", a prefix check would accept it.
    const status = await rawStatus('/%2e%2e%2fclient-secret%2fsecret.txt');
    expect(status).toBe(403);
  });

  it('refuses a path with a backslash separator', async () => {
    const status = await rawStatus('/%2e%2e%5csecret.txt');
    expect(status).toBe(403);
  });

  it('refuses a request from another origin', async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'https://evil.test' },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('evil.test');
  });

  it('accepts a request from the origin of the server', async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: baseUrl },
    });
    expect(response.status).toBe(200);
  });

  it('refuses a body that is not JSON', async () => {
    const response = await fetch(`${baseUrl}/api/proxy/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'baseUrl=http://127.0.0.1:1/v1',
    });
    expect(response.status).toBe(415);
  });

  it('refuses a body without a content type', async () => {
    const response = await fetch(`${baseUrl}/api/proxy/models`, {
      method: 'POST',
      body: 'baseUrl=http://127.0.0.1:1/v1',
    });
    expect(response.status).toBe(415);
  });
});

describe('the destination policy of the local proxy backend', () => {
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;

  beforeAll(async () => {
    const fs = await import('node:fs/promises');
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaggle-kit-destinations-'));

    const config: ServerConfig = {
      ...loadServerConfig({}, process.cwd()),
      dataDir,
      secretsFile: path.join(dataDir, 'secrets.json'),
      clientDir: path.join(dataDir, 'client'),
      allowedHosts: ['allowed.test'],
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

  it('refuses an upstream that is not on the allow list', async () => {
    const response = await fetch(`${baseUrl}/api/proxy/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1' }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('allow list');
  });

  it('does not reach a host that is not on the allow list', async () => {
    const response = await fetch(`${baseUrl}/api/proxy/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://not-allowed.test/v1' }),
    });

    expect(response.status).toBe(400);
  });
});

describe('the streaming route of the proxy', () => {
  it('is only reachable with a JSON body', async () => {
    const fs = await import('node:fs/promises');
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaggle-kit-stream-policy-'));
    const config: ServerConfig = {
      ...loadServerConfig({}, process.cwd()),
      dataDir,
      secretsFile: path.join(dataDir, 'secrets.json'),
      clientDir: path.join(dataDir, 'client'),
      allowedHosts: null,
    };
    const local = createApp({ config, logger: createLogger({ sink: () => undefined }) });
    await new Promise<void>((resolve) => local.server.listen(0, '127.0.0.1', resolve));
    const address = local.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/api/proxy/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });

    expect(response.status).toBe(415);
    await new Promise<void>((resolve) => local.server.close(() => resolve()));
  });
});
