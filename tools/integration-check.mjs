#!/usr/bin/env node
/**
 * Integration check of the built application.
 *
 * The script starts the mock upstream and the *built* proxy backend
 * (``dist/server/index.js``) and drives the real HTTP surface of the
 * application:
 *
 *  - the health endpoint of the backend,
 *  - the connection test with a correct and with a wrong key,
 *  - a chat completion through the proxy,
 *  - a streaming answer, including the termination marker,
 *  - the cancellation of a running stream.
 *
 * It talks to the backend over HTTP, exactly like the browser does, and it
 * checks the answers of the built client. It needs no GPU, no weights and no
 * tunnel.
 *
 *   node tools/integration-check.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const API_KEY = 'integration-check-key';
const failures = [];
let checks = 0;

function ok(name) {
  checks += 1;
  process.stdout.write(`  ok   ${name}\n`);
}

function fail(name, detail) {
  checks += 1;
  failures.push(`${name}: ${detail}`);
  process.stdout.write(`  FAIL ${name}: ${detail}\n`);
}

function assert(name, condition, detail = '') {
  if (condition) ok(name);
  else fail(name, detail || 'the condition was not met');
}

async function waitForPort(port, host = '127.0.0.1', timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ port, host });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function post(baseUrl, route, body, headers = {}) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function main() {
  const upstreamPort = 18_100;
  const backendPort = 18_101;

  const upstream = spawn(
    process.execPath,
    [path.join(root, 'tools/mock-upstream.mjs'), '--port', String(upstreamPort), '--api-key', API_KEY],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  upstream.stdout.on('data', () => undefined);
  upstream.stderr.on('data', (chunk) => process.stderr.write(`[upstream] ${chunk}`));

  const backend = spawn(process.execPath, [path.join(root, 'dist/server/index.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KAGGLE_KIT_PORT: String(backendPort),
      KAGGLE_KIT_HOST: '127.0.0.1',
      KAGGLE_KIT_DATA_DIR: path.join(root, '.data/integration'),
      KAGGLE_KIT_CLIENT_DIR: path.join(root, 'dist/client'),
    },
  });
  backend.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
  backend.stderr.on('data', (chunk) => process.stderr.write(`[backend] ${chunk}`));

  const stop = () => {
    upstream.kill('SIGTERM');
    backend.kill('SIGTERM');
  };
  process.on('exit', stop);
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });

  try {
    const upstreamReady = await waitForPort(upstreamPort);
    assert('the mock upstream starts', upstreamReady, 'the port did not open');
    const backendReady = await waitForPort(backendPort);
    assert('the built backend starts', backendReady, 'the port did not open');
    if (!upstreamReady || !backendReady) return;

    const base = `http://127.0.0.1:${backendPort}`;
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}/v1`;

    // 1. the health endpoint
    const health = await fetch(`${base}/api/health`);
    assert('the health endpoint answers', health.status === 200, `HTTP ${health.status}`);

    // 2. the built client is served
    const index = await fetch(`${base}/`);
    const indexText = await index.text();
    assert('the built client is served', index.status === 200 && indexText.includes('<'), `HTTP ${index.status}`);

    // 3. the connection test with the correct key
    const test = await post(base, '/api/proxy/test', {
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      timeoutMs: 10_000,
    });
    const testBody = await test.json();
    assert('the connection test succeeds', test.status === 200 && testBody.ok === true, JSON.stringify(testBody));
    assert(
      'the connection test runs a real inference',
      Array.isArray(testBody.stages) && testBody.stages.some((stage) => stage.stage === 'inference' && stage.status === 'ok'),
      JSON.stringify(testBody.stages),
    );

    // 4. the connection test with a wrong key
    const wrong = await post(base, '/api/proxy/test', {
      baseUrl: upstreamUrl,
      apiKey: 'wrong-key',
      timeoutMs: 10_000,
    });
    const wrongText = await wrong.text();
    const wrongBody = JSON.parse(wrongText);
    assert(
      'a wrong key is reported',
      wrong.status === 200 && wrongBody.ok === false && wrongBody.errorKind === 'auth',
      `HTTP ${wrong.status}: ${wrongText.slice(0, 200)}`,
    );
    assert('the wrong key is not echoed', !wrongText.includes('wrong-key'), 'the key appeared in the answer');

    // 5. a chat completion through the proxy
    const chat = await post(base, '/api/proxy/chat', {
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Hello' }],
      params: { maxTokens: 32, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    const chatBody = await chat.json();
    assert(
      'the chat completion is proxied',
      chat.status === 200 && typeof chatBody.response?.choices?.[0]?.message?.content === 'string',
      JSON.stringify(chatBody).slice(0, 300),
    );

    // 6. the streaming probe and a streaming answer
    const probe = await post(base, '/api/proxy/probe-stream', {
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      timeoutMs: 10_000,
    });
    const probeBody = await probe.json();
    assert('the streaming probe succeeds', probe.status === 200 && probeBody.supported === true, JSON.stringify(probeBody));

    const streamed = await post(base, '/api/proxy/chat', {
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Hello' }],
      params: { stream: true, maxTokens: 32 },
      timeoutMs: 10_000,
    });
    const streamText = await streamed.text();
    assert(
      'the stream is delivered completely',
      streamed.status === 200 && streamText.includes('data: ') && streamText.includes('[DONE]'),
      `HTTP ${streamed.status}: ${streamText.slice(0, 200)}`,
    );

    // 7. the cancellation of a running stream
    const cancelled = await new Promise((resolve) => {
      const payload = JSON.stringify({
        baseUrl: upstreamUrl,
        apiKey: API_KEY,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello' }],
        params: { stream: true, maxTokens: 32 },
        timeoutMs: 10_000,
      });
      const request = http.request(
        `${base}/api/proxy/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (response) => {
          let received = 0;
          response.on('data', (chunk) => {
            received += chunk.length;
            if (received > 0) {
              request.destroy();
              resolve(true);
            }
          });
          response.on('end', () => resolve(false));
        },
      );
      request.on('error', () => resolve(true));
      request.end(payload);
    });
    assert('a stream can be cancelled', cancelled === true, 'the stream was not closed by the client');

    // 8. the request policy
    const foreignOrigin = await fetch(`${base}/api/health`, {
      headers: { Origin: 'https://evil.test' },
    });
    assert('a request from another origin is refused', foreignOrigin.status === 403, `HTTP ${foreignOrigin.status}`);

    const wrongType = await fetch(`${base}/api/proxy/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'x',
    });
    assert('a body that is not JSON is refused', wrongType.status === 415, `HTTP ${wrongType.status}`);
  } finally {
    stop();
  }
}

await main();

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.exit(1);
}
process.exit(0);
