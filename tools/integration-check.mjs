#!/usr/bin/env node
/**
 * Integration check of the built application.
 *
 * The script copies the *built* client and proxy backend (``dist/``) to a
 * temporary standalone app directory without ``node_modules``, starts that
 * backend and a mock upstream, and drives the real HTTP surface of the
 * application:
 *
 *  - the health endpoint of the backend,
 *  - the connection test with a correct and with a wrong key,
 *  - a chat completion through the proxy,
 *  - PDF and DOCX parsing in the standalone backend,
 *  - a streaming answer, including the termination marker,
 *  - the cancellation of a running stream.
 *
 * It talks to the backend over HTTP, exactly like the browser does, and it
 * checks the answers of the built client. It needs no GPU, no weights and no
 * tunnel, and the default run is deterministic: it performs no successful
 * outbound retrieval from the public internet, so a blocked or rate-limited
 * network cannot fail it.
 *
 *   node tools/integration-check.mjs             # deterministic, used by CI
 *   node tools/integration-check.mjs --network   # adds the public web_open check
 *
 * The opt-in `--network` run performs one real HTTPS retrieval through the
 * built tool loop (pypi.org) and therefore needs outbound internet access. It
 * is the only check that depends on a third-party host; the refusal checks
 * (`*.invalid`, loopback, a documentation address) stay in the default run
 * because they must fail before any public request is made.
 */

import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const API_KEY = 'integration-check-key';
/** Opt-in: performs a real public retrieval. Never enabled by CI. */
const networkCheck = process.argv.includes('--network');
const failures = [];
let checks = 0;
const skipped = [];

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

/** A check that is not part of this run; it is reported, never counted. */
function skip(name, reason) {
  skipped.push(`${name}: ${reason}`);
  process.stdout.write(`  skip ${name} (${reason})\n`);
}

/** The numeric part of a calculator_convert summary such as "0 °C". */
function summaryValue(summary) {
  return String(summary ?? '').trim().split(/\s+/)[0] ?? '';
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
  const standaloneRoot = await mkdtemp(path.join(os.tmpdir(), 'kaggle-kit-integration-'));
  let upstream;
  let backend;

  const stop = () => {
    upstream?.kill('SIGTERM');
    backend?.kill('SIGTERM');
  };

  process.on('exit', stop);
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });

  try {
    const standaloneServerDir = path.join(standaloneRoot, 'dist/server');
    const standaloneClientDir = path.join(standaloneRoot, 'dist/client');
    await mkdir(standaloneServerDir, { recursive: true });
    await cp(path.join(root, 'dist/server/index.js'), path.join(standaloneServerDir, 'index.js'));
    await cp(path.join(root, 'dist/client'), standaloneClientDir, { recursive: true });

    upstream = spawn(
      process.execPath,
      [path.join(root, 'tools/mock-upstream.mjs'), '--port', String(upstreamPort), '--api-key', API_KEY],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    upstream.stdout.on('data', () => undefined);
    upstream.stderr.on('data', (chunk) => process.stderr.write(`[upstream] ${chunk}`));

    backend = spawn(process.execPath, [path.join(standaloneServerDir, 'index.js')], {
      cwd: standaloneRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KAGGLE_KIT_PORT: String(backendPort),
        KAGGLE_KIT_HOST: '127.0.0.1',
        KAGGLE_KIT_DATA_DIR: path.join(standaloneRoot, '.data/integration'),
        KAGGLE_KIT_CLIENT_DIR: standaloneClientDir,
      },
    });
    backend.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
    backend.stderr.on('data', (chunk) => process.stderr.write(`[backend] ${chunk}`));
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

    // 6. file parsing through the built bundle (including bundled PDF/DOCX parsers)
    const pdfBytes = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDUgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiA3MiAxMDAgVGQgKEhlbGxvIFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwMQolJUVPRgo=';
    const docxBytes = 'UEsDBBQAAAAIAAkoVF1MBC9KmgAAAMcAAAARAAAAd29yZC9kb2N1bWVudC54bWxFjr0OwjAMhF8lyk5TGBCq2jKAEBsLSKwlcX+kOI6cQOHtScrA8p18Z59c799oxQs4TOQauS5KKcBpMpMbGnm7nlY7uW/ruTKknwguirTvQjU3cozRV0oFPQJ2oSAPLmU9MXYxjTyomdh4Jg0hpDq0alOWW4Xd5GSufJD5ZPUZnBHbM1hLomdCcbwc7rXKZiYv9At/h+r/VPsFUEsBAhQDFAAAAAgACShUXUwEL0qaAAAAxwAAABEAAAAAAAAAAAAAAIABAAAAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAABAAEAPwAAAMkAAAAAAA==';
    for (const [name, mediaType, contentBase64] of [
      ['report.pdf', 'application/pdf', pdfBytes],
      ['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docxBytes],
    ]) {
      const upload = await post(base, '/api/tools/files/upload', {
        conversationId: 'integration-files', name, mediaType, contentBase64,
      });
      const uploadBody = await upload.json();
      assert(`the built bundle parses ${name}`, upload.status === 201 && uploadBody.file?.extractedCharacters > 0, JSON.stringify(uploadBody));
      assert(`the ${name} contents are not returned`, !JSON.stringify(uploadBody).includes('Hello'));
    }
    const deleteFiles = await fetch(`${base}/api/tools/files?conversationId=integration-files`, { method: 'DELETE' });
    assert('the built file vault can be cleared', deleteFiles.status === 200, `HTTP ${deleteFiles.status}`);

    // 7. the streaming probe and a streaming answer
    const probe = await post(base, '/api/proxy/probe-stream', {
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      timeoutMs: 10_000,
    });
    const probeBody = await probe.json();
    assert('the streaming probe succeeds', probe.status === 200 && probeBody.supported === true, JSON.stringify(probeBody));

    const streamStartedAt = Date.now();
    const streamed = await post(base, '/api/proxy/chat', {
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Hello' }],
      params: { stream: true, maxTokens: 32 },
      timeoutMs: 10_000,
    });
    // Read the body incrementally: reading it with .text() proves only that
    // one HTTP response arrived, which a buffering proxy would also produce.
    const streamChunks = [];
    let streamText = '';
    const streamReader = streamed.body?.getReader();
    const streamDecoder = new TextDecoder();
    for (;;) {
      const { done, value } = await streamReader.read();
      if (done) break;
      const chunkText = streamDecoder.decode(value, { stream: true });
      streamText += chunkText;
      streamChunks.push({ at: Date.now() - streamStartedAt, text: chunkText });
    }
    assert(
      'the stream is delivered completely',
      streamed.status === 200 && streamText.includes('data: ') && streamText.includes('[DONE]'),
      `HTTP ${streamed.status}: ${streamText.slice(0, 200)}`,
    );
    // The mock writes its five words 60 ms apart, so a forwarding proxy lets
    // the client see the first word long before [DONE] arrives.
    const firstStreamChunk = streamChunks[0];
    assert(
      'the stream is forwarded incrementally, not buffered',
      // A buffering proxy produces exactly one chunk that already contains the
      // termination marker; a forwarding one delivers readable prefixes first.
      streamChunks.length >= 2 &&
        Boolean(firstStreamChunk) &&
        !firstStreamChunk.text.includes('[DONE]'),
      `${streamChunks.length} chunk(s): ${JSON.stringify(streamChunks.map((chunk) => chunk.at))}`,
    );
    process.stdout.write(
      `       streaming chunks: ${streamChunks.map((chunk) => chunk.at).join(', ')} ms\n`,
    );

    // 7b. vLLM-style reasoning stays a separate channel end to end: the
    // streamed frames carry delta.reasoning (never merged into content) and
    // the non-streamed answer carries message.reasoning next to content.
    const reasoningStream = await post(base, '/api/proxy/chat', {
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'reasoning: hello' }],
      params: { stream: true, maxTokens: 32 },
      timeoutMs: 10_000,
    });
    const reasoningStreamText = await reasoningStream.text();
    assert(
      'the stream forwards vLLM-style reasoning deltas separately from content',
      reasoningStream.status === 200 &&
        reasoningStreamText.includes('"reasoning":"mock "') &&
        reasoningStreamText.includes('"reasoning":"thinking"') &&
        reasoningStreamText.includes('"content":"This "') &&
        reasoningStreamText.includes('[DONE]'),
      `HTTP ${reasoningStream.status}: ${reasoningStreamText.slice(0, 300)}`,
    );

    const reasoningChat = await post(base, '/api/proxy/chat', {
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'reasoning: hello' }],
      params: { stream: false, maxTokens: 32 },
      timeoutMs: 10_000,
    });
    const reasoningChatBody = await reasoningChat.json();
    const reasoningMessage = reasoningChatBody.response?.choices?.[0]?.message ?? {};
    assert(
      'the non-streamed answer keeps message.reasoning separate from content',
      reasoningChat.status === 200 &&
        reasoningMessage.reasoning === 'mock thinking' &&
        typeof reasoningMessage.content === 'string' &&
        !reasoningMessage.content.includes('mock thinking'),
      JSON.stringify(reasoningChatBody).slice(0, 300),
    );

    // 8. the cancellation of a running stream
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

    // 9. the request policy
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

    // 10. the tool loop: probe, profile, automatic read-only call, approval
    const pinnedImage = `python:3.12-alpine@sha256:${'a'.repeat(64)}`;
    const saveProfile = await fetch(`${base}/api/tools/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: 'integration-tools',
        settings: {
          enabled: true,
          allowedTools: [
            'calculator_calculate',
            'calculator_convert',
            'diagnostics_check',
            'code_execute',
            'files_list',
            'files_read',
            'files_analyze',
            'web_open',
          ],
          limits: {
            maxRounds: 3,
            maxCalls: 8,
            perToolTimeoutMs: 15_000,
            loopTimeoutMs: 120_000,
            maxInputBytes: 8_192,
            maxOutputBytes: 24_000,
          },
          historyPersistence: false,
          web: { provider: 'disabled' },
          httpTools: [],
          mcpServers: [],
          code: {
            provider: 'docker',
            image: pinnedImage,
            isolation: 'strict',
            network: 'none',
            timeoutMs: 10_000,
            memoryMb: 128,
            cpuCores: 0.5,
            maxProcesses: 32,
            outputBytes: 8_192,
          },
        },
      }),
    });
    const saveProfileBody = await saveProfile.json();
    assert(
      'the built backend stores sanitized tool settings',
      saveProfile.status === 200 && saveProfileBody.settings?.code?.provider === 'docker',
      `HTTP ${saveProfile.status}: ${JSON.stringify(saveProfileBody).slice(0, 200)}`,
    );

    // Tool chat must refuse to run before the harmless probe verifies support.
    const unverifiedChat = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-tools-conversation',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'calculate: 2+3' }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    assert(
      'tool chat refuses an unverified endpoint',
      unverifiedChat.status === 409,
      `HTTP ${unverifiedChat.status}`,
    );

    const capability = await post(base, '/api/tools/capability', {
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      timeoutMs: 10_000,
    });
    const capabilityBody = await capability.json();
    assert(
      'the harmless probe verifies native tool calling against the mock',
      capability.status === 200 && capabilityBody.status === 'supported_verified',
      `HTTP ${capability.status}: ${JSON.stringify(capabilityBody).slice(0, 200)}`,
    );
    assert(
      'the probe assembles streamed tool-call fragments',
      capabilityBody.streamingSupported === true,
      JSON.stringify(capabilityBody).slice(0, 200),
    );

    const calculatorChat = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-tools-conversation',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'calculate: 2+3' }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    const calculatorBody = await calculatorChat.json();
    assert(
      'a read-only calculator call runs automatically and completes the loop',
      calculatorChat.status === 200
        && calculatorBody.status === 'complete'
        && calculatorBody.toolTrace?.some((entry) => entry.toolName === 'calculator_calculate' && entry.status === 'succeeded')
        && String(calculatorBody.content).includes('"value":5'),
      `HTTP ${calculatorChat.status}: ${JSON.stringify(calculatorBody).slice(0, 300)}`,
    );
    assert(
      'the API key is not echoed in the tool trace',
      !JSON.stringify(calculatorBody).includes(API_KEY),
      'the key appeared in the tool chat answer',
    );

    // The historical conversion errors are checked through the real tool loop:
    // the trace records the exact arguments and the executor's own result, so
    // the model's prose is not the evidence.
    for (const [prompt, from, to, expected] of [
      ['convert: 32 °F to °C', '°F', '°C', '0'],
      ['convert: 100 °F to °C', '°F', '°C', '37.7777777778'],
      ['convert: 100 km/h to mph', 'km/h', 'mph', '62.1371192237'],
    ]) {
      const converted = await post(base, '/api/tools/chat', {
        profileId: 'integration-tools',
        conversationId: 'integration-tools-conversation',
        baseUrl: upstreamUrl,
        apiKey: API_KEY,
        model: 'mock-model',
        messages: [{ role: 'user', content: prompt }],
        params: { maxTokens: 128, temperature: 0, topP: 1 },
        timeoutMs: 10_000,
      });
      const convertedBody = await converted.json();
      const convertTrace = convertedBody.toolTrace?.find((entry) => entry.toolName === 'calculator_convert');
      assert(
        `calculator_convert is correct for "${prompt}"`,
        converted.status === 200 &&
          convertTrace?.status === 'succeeded' &&
          convertTrace?.safeArguments?.from === from &&
          convertTrace?.safeArguments?.to === to &&
          // Exact numeric comparison, not a substring: "100 °C", "10 °C" and
          // "0.5 °C" must not satisfy an expected "0".
          summaryValue(convertTrace?.resultSummary) === expected,
        `HTTP ${converted.status}: ${JSON.stringify(convertTrace ?? convertedBody).slice(0, 400)}`,
      );
    }

    // The comparator itself: a look-alike summary must not pass for "0".
    assert(
      'the conversion comparison rejects look-alike values instead of substring matches',
      summaryValue('0 °C') === '0' &&
        ['100 °C', '10 °C', '0.5 °C', '-0.5 °C', '0.0 °C'].every((value) => summaryValue(value) !== '0'),
      'a look-alike summary satisfied the expected value',
    );

    const belowZero = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-tools-conversation',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'convert: -300 °C to K' }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    const belowZeroBody = await belowZero.json();
    const belowZeroTrace = belowZeroBody.toolTrace?.find((entry) => entry.toolName === 'calculator_convert');
    assert(
      'a physically impossible conversion fails instead of returning a number',
      belowZero.status === 200 &&
        belowZeroTrace?.status === 'failed' &&
        /absolute zero/i.test(String(belowZeroTrace?.error ?? belowZeroBody.content)),
      `HTTP ${belowZero.status}: ${JSON.stringify(belowZeroTrace ?? belowZeroBody).slice(0, 400)}`,
    );

    // 10b. real uploads through the built backend, then real file reads and
    // analyses through the tool loop. The model is scripted; the file vault,
    // the extractors and the executor are the real ones.
    const csv = 'department,amount\nengineering,1200\nmarketing,800\nsupport,400\n';
    const upload = await post(base, '/api/tools/files/upload', {
      conversationId: 'integration-files-tools',
      name: 'budget.csv',
      mediaType: 'text/csv',
      contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
    });
    const uploadBody = await upload.json();
    const fileId = uploadBody.file?.id;
    assert(
      'a real CSV upload returns a usable file ID and exact metadata',
      upload.status === 201 &&
        typeof fileId === 'string' &&
        uploadBody.file.name === 'budget.csv' &&
        uploadBody.file.size === Buffer.byteLength(csv) &&
        uploadBody.file.extractedCharacters === csv.length,
      `HTTP ${upload.status}: ${JSON.stringify(uploadBody).slice(0, 300)}`,
    );

    const listed = await fetch(`${base}/api/tools/files?conversationId=integration-files-tools`);
    const listedBody = await listed.json();
    assert(
      'the uploaded file is listed for its conversation only',
      listed.status === 200 && listedBody.files?.some((file) => file.id === fileId),
      JSON.stringify(listedBody).slice(0, 200),
    );

    const readChat = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-files-tools',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: `read file: ${fileId}` }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    const readBody = await readChat.json();
    assert(
      'files_read returns the real uploaded bytes, not a summary of them',
      readChat.status === 200 &&
        readBody.status === 'complete' &&
        readBody.toolTrace?.some(
          (entry) => entry.toolName === 'files_read' && entry.status === 'succeeded' && entry.safeArguments?.file_id === fileId,
        ) &&
        String(readBody.content).includes('marketing,800'),
      `HTTP ${readChat.status}: ${JSON.stringify(readBody).slice(0, 400)}`,
    );

    const analyzeChat = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-files-tools',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: `analyze file: ${fileId} :: Which department has the highest amount?` }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    const analyzeBody = await analyzeChat.json();
    const analyzeTrace = analyzeBody.toolTrace?.find((entry) => entry.toolName === 'files_analyze');
    assert(
      'files_analyze reports the real structure and keyword matches',
      analyzeChat.status === 200 &&
        analyzeBody.status === 'complete' &&
        analyzeTrace?.status === 'succeeded' &&
        analyzeTrace?.safeArguments?.question === 'Which department has the highest amount?' &&
        String(analyzeTrace?.resultSummary ?? '').includes('budget.csv') &&
        String(analyzeBody.content).includes('budget.csv'),
      `HTTP ${analyzeChat.status}: ${JSON.stringify(analyzeBody).slice(0, 400)}`,
    );

    const missingFileChat = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-files-tools',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'read file: 00000000-0000-4000-8000-000000000000' }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    const missingFileBody = await missingFileChat.json();
    const missingTrace = missingFileBody.toolTrace?.find((entry) => entry.toolName === 'files_read');
    assert(
      'an unknown file ID fails the tool call instead of inventing content',
      missingFileChat.status === 200 &&
        missingTrace?.status === 'failed' &&
        String(missingFileBody.content).toLowerCase().includes('unavailable') &&
        !String(missingFileBody.content).includes('marketing,800'),
      `HTTP ${missingFileChat.status}: ${JSON.stringify(missingFileBody).slice(0, 400)}`,
    );

    const emptyUpload = await post(base, '/api/tools/files/upload', {
      conversationId: 'integration-files-tools', name: 'empty.txt', mediaType: 'text/plain', contentBase64: '',
    });
    assert(
      'an empty upload is refused',
      emptyUpload.status >= 400 && emptyUpload.status < 500,
      `HTTP ${emptyUpload.status}: ${await emptyUpload.text()}`,
    );
    const unsupportedUpload = await post(base, '/api/tools/files/upload', {
      conversationId: 'integration-files-tools',
      name: 'payload.exe',
      mediaType: 'application/octet-stream',
      contentBase64: Buffer.from('MZ\u0000binary').toString('base64'),
    });
    assert(
      'an unsupported file type is refused',
      unsupportedUpload.status >= 400 && unsupportedUpload.status < 500,
      `HTTP ${unsupportedUpload.status}: ${await unsupportedUpload.text()}`,
    );
    const oversizeUpload = await post(base, '/api/tools/files/upload', {
      conversationId: 'integration-files-tools',
      name: 'huge.txt',
      mediaType: 'text/plain',
      contentBase64: Buffer.alloc(4 * 1024 * 1024 + 1, 0x61).toString('base64'),
    });
    assert(
      'an upload above the 4 MiB limit is refused',
      oversizeUpload.status >= 400 && oversizeUpload.status < 500,
      `HTTP ${oversizeUpload.status}: ${await oversizeUpload.text()}`,
    );

    // 10c. web_open through the real tool loop. The successful public
    // retrieval is the one check that depends on the public internet; it is
    // opt-in (`--network`) so a blocked network cannot fail the deterministic
    // integration workflow.
    if (networkCheck) {
      const webChat = await post(base, '/api/tools/chat', {
        profileId: 'integration-tools',
        conversationId: 'integration-web-tools',
        baseUrl: upstreamUrl,
        apiKey: API_KEY,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'open url: https://pypi.org/pypi/requests/json' }],
        params: { maxTokens: 128, temperature: 0, topP: 1 },
        timeoutMs: 20_000,
      });
      const webBody = await webChat.json();
      const webTrace = webBody.toolTrace?.find((entry) => entry.toolName === 'web_open');
      assert(
        'web_open retrieves a real public page through the tool loop',
        webChat.status === 200 &&
          webBody.status === 'complete' &&
          webTrace?.status === 'succeeded' &&
          JSON.stringify(webBody.sourceCitations ?? []).includes('pypi.org'),
        `HTTP ${webChat.status}: ${JSON.stringify(webBody).slice(0, 400)}`,
      );
    } else {
      skip('web_open retrieves a real public page through the tool loop', 'pass --network to run the opt-in public retrieval');
    }

    const blockedWebChat = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-web-tools',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'open url: https://kaggle-kit-no-such-host.invalid/' }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 20_000,
    });
    const blockedWebBody = await blockedWebChat.json();
    const blockedWebTrace = blockedWebBody.toolTrace?.find((entry) => entry.toolName === 'web_open');
    assert(
      'an unreachable web destination fails the tool call with a reason',
      blockedWebChat.status === 200 &&
        blockedWebTrace?.status === 'failed' &&
        /resolve|could not be reached/i.test(String(blockedWebBody.content)),
      `HTTP ${blockedWebChat.status}: ${JSON.stringify(blockedWebBody).slice(0, 400)}`,
    );

    const clearToolFiles = await fetch(`${base}/api/tools/files?conversationId=integration-files-tools`, { method: 'DELETE' });
    assert('the tool file vault can be cleared', clearToolFiles.status === 200, `HTTP ${clearToolFiles.status}`);

    // 10d. diagnostics through the real tool loop: each claim keeps its own
    // status, and streaming is not claimed from the earlier tool probe.
    const diagnostics = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-tools-conversation',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'diagnostics: check this endpoint' }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 30_000,
    });
    const diagnosticsBody = await diagnostics.json();
    const diagnosticsTrace = diagnosticsBody.toolTrace?.find((entry) => entry.toolName === 'diagnostics_check');
    assert(
      'diagnostics_check separates inference from what it cannot verify',
      diagnostics.status === 200 &&
        diagnosticsTrace?.status === 'succeeded' &&
        /inference verified/i.test(String(diagnosticsTrace?.resultSummary)) &&
        /streaming verified earlier in this server session/i.test(String(diagnosticsTrace?.resultSummary)) &&
        /not proof of proxy forwarding or browser rendering/i.test(String(diagnosticsTrace?.resultSummary)) &&
        !/passed/i.test(String(diagnosticsTrace?.resultSummary)),
      `HTTP ${diagnostics.status}: ${JSON.stringify(diagnosticsTrace ?? diagnosticsBody).slice(0, 400)}`,
    );

    // A protocol-violating upstream turn (tool-call data with the wrong
    // finish_reason) must spend exactly one bounded corrective round, execute
    // nothing from the invalid turn, and report the recovery honestly.
    const inconsistentChat = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-tools-conversation',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'inconsistent calculate: 2+3' }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    const inconsistentBody = await inconsistentChat.json();
    assert(
      'a protocol failure spends one bounded corrective round and runs nothing from it',
      inconsistentChat.status === 200
        && inconsistentBody.status === 'complete'
        && inconsistentBody.recovery?.attempts === 1
        && inconsistentBody.toolTrace?.some((entry) => entry.status === 'failed' && /finish_reason=tool_calls/.test(entry.error ?? ''))
        && !inconsistentBody.toolTrace?.some((entry) => entry.status === 'succeeded'),
      `HTTP ${inconsistentChat.status}: ${JSON.stringify(inconsistentBody).slice(0, 300)}`,
    );

    const codeChat = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-tools-conversation',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'run code: print(1)' }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    const codeBody = await codeChat.json();
    assert(
      'code execution pauses for explicit approval',
      codeChat.status === 200
        && codeBody.status === 'awaiting_approval'
        && codeBody.pendingApproval?.toolName === 'code_execute',
      `HTTP ${codeChat.status}: ${JSON.stringify(codeBody).slice(0, 300)}`,
    );

    const denied = await post(base, '/api/tools/approve', {
      jobId: codeBody.jobId,
      approvalId: codeBody.pendingApproval?.approvalId,
      approved: false,
    });
    const deniedBody = await denied.json();
    assert(
      'a denied code run is not executed and the loop still completes',
      denied.status === 200
        && deniedBody.status === 'complete'
        && deniedBody.toolTrace?.some((entry) => entry.toolName === 'code_execute' && entry.status === 'denied'),
      `HTTP ${denied.status}: ${JSON.stringify(deniedBody).slice(0, 300)}`,
    );

    // Approvals are single-use: replaying the same approval must fail.
    const replayed = await post(base, '/api/tools/approve', {
      jobId: codeBody.jobId,
      approvalId: codeBody.pendingApproval?.approvalId,
      approved: true,
    });
    assert(
      'a used approval cannot be replayed',
      replayed.status === 410,
      `HTTP ${replayed.status}`,
    );

    // An empty model ID resolves through the endpoint model list, the same
    // contract ordinary chat uses; the verified capability of the discovered
    // model is still required and enforced.
    const emptyModelChat = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-empty-model-conversation',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: '',
      messages: [{ role: 'user', content: 'calculate: 21 * 2' }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    const emptyModelBody = await emptyModelChat.json();
    assert(
      'tool chat auto-discovers an empty model ID and completes the calculator loop',
      emptyModelChat.status === 200
        && emptyModelBody.status === 'complete'
        && emptyModelBody.toolTrace?.some((entry) => entry.toolName === 'calculator_calculate' && entry.status === 'succeeded')
        && String(emptyModelBody.content).includes('"value":42'),
      `HTTP ${emptyModelChat.status}: ${JSON.stringify(emptyModelBody).slice(0, 300)}`,
    );

    // Deleting the conversation's files cancels its pending tool jobs, so no
    // approval stays open for file-dependent tools whose input is gone.
    const cancelChat = await post(base, '/api/tools/chat', {
      profileId: 'integration-tools',
      conversationId: 'integration-cancel-conversation',
      baseUrl: upstreamUrl,
      apiKey: API_KEY,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'run code: print(1)' }],
      params: { maxTokens: 128, temperature: 0, topP: 1 },
      timeoutMs: 10_000,
    });
    const cancelBody = await cancelChat.json();
    const removedFiles = await fetch(
      `${base}/api/tools/files?conversationId=${encodeURIComponent('integration-cancel-conversation')}`,
      { method: 'DELETE' },
    );
    const approveAfterCancel = await post(base, '/api/tools/approve', {
      jobId: cancelBody.jobId,
      approvalId: cancelBody.pendingApproval?.approvalId,
      approved: true,
    });
    assert(
      'removing a conversation files set cancels its paused tool job and its approval',
      cancelChat.status === 200
        && cancelBody.status === 'awaiting_approval'
        && removedFiles.status === 200
        && approveAfterCancel.status === 410,
      `chat HTTP ${cancelChat.status}; delete HTTP ${removedFiles.status}; approve HTTP ${approveAfterCancel.status}`,
    );
  } finally {
    stop();
    process.off('exit', stop);
    await rm(standaloneRoot, { recursive: true, force: true });
  }
}

await main();

const skippedNote = skipped.length > 0 ? `, ${skipped.length} skipped (not counted)` : '';
process.stdout.write(`\n${checks - failures.length}/${checks} checks passed${skippedNote}\n`);
if (!networkCheck) {
  process.stdout.write('  mode: deterministic (no public retrieval; pass --network to add it)\n');
}
for (const entry of skipped) process.stdout.write(`  skipped - ${entry}\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.exit(1);
}
process.exit(0);
