// @vitest-environment jsdom
/**
 * Real-transport regression test for visible incremental streaming.
 *
 * This test does NOT mock the gateway, the proxy or the chat controller. It
 * starts the real backend (`createApp`) against a real HTTP upstream and
 * renders the real application in jsdom. `fetch` is the real Node fetch; only
 * same-origin relative URLs are resolved against the ephemeral backend port,
 * exactly as a browser resolves them on the application origin.
 *
 * The upstream writes one delta and then waits for the test to release the
 * rest of the answer. If anything in the chain - proxy forwarding, gateway
 * reading, controller flushing, reducer, render - buffered the answer, the
 * head could not appear in the DOM before the release, and this test fails.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_INFERENCE_PARAMS } from '../../shared/api/requests';
import type { ApiProfile } from '../../shared/domain';
import { DEFAULT_TOOL_PROFILE_SETTINGS } from '../../shared/tools/types';
import { App } from '../App';
import { STORAGE_KEYS } from '../lib/storage';
import { AppProvider } from '../state/AppProvider';
import { createApp } from '../../server/app';
import { loadServerConfig, type ServerConfig } from '../../server/config';
import { createLogger } from '../../server/logger';

const ANSWER_HEAD = 'Partial answer: ';
const ANSWER_TAIL = 'the rest arrived later.';
const GATED_PROMPT = 'Stream please';

interface Gate {
  opened: boolean;
  release: () => void;
  wait: Promise<void>;
}

let upstream: http.Server;
let app: ReturnType<typeof createApp>;
let appOrigin = '';
let upstreamUrl = '';
let gate: Gate;
const requestLog: Array<{ path: string; stream: boolean; at: number }> = [];

function createGate(): Gate {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const state: Gate = {
    opened: false,
    wait,
    release: () => {
      if (state.opened) return;
      state.opened = true;
      release();
    },
  };
  return state;
}

function writeFrame(response: http.ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startUpstream(): Promise<void> {
  upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const stream = body.stream === true;
      requestLog.push({ path: request.url ?? '', stream, at: Date.now() });

      if (request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }

      if (request.url === '/props') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ chat_template_caps: {} }));
        return;
      }

      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      if (!stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            model: 'mock-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
            ],
          }),
        );
        return;
      }

      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const prompt = messages
        .map((message) => (message as { content?: unknown }).content)
        .filter((content): content is string => typeof content === 'string')
        .join('\n');
      const gated = prompt.includes(GATED_PROMPT);

      if (!gated) {
        // The streaming capability probe and any ordinary stream: a complete
        // short answer with a finish marker.
        writeFrame(response, { choices: [{ delta: { content: 'OK' } }] });
        writeFrame(response, { choices: [{ delta: {}, finish_reason: 'stop' }] });
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }

      writeFrame(response, { choices: [{ delta: { content: ANSWER_HEAD } }] });
      // A comment frame proves the connection is alive but is not answer text.
      response.write(': waiting for the test to release the rest\n\n');

      void gate.wait.then(() => {
        writeFrame(response, { choices: [{ delta: { content: ANSWER_TAIL } }] });
        writeFrame(response, { choices: [{ delta: {}, finish_reason: 'stop' }] });
        response.write('data: [DONE]\n\n');
        response.end();
      });
      response.on('close', () => gate.release());
    });
  });
  return new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
}

beforeAll(async () => {
  await startUpstream();
  const address = upstream.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  upstreamUrl = `http://127.0.0.1:${port}/v1`;

  const dataDir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), 'kaggle-kit-visible-stream-')),
  );
  const config: ServerConfig = {
    ...loadServerConfig({}, process.cwd()),
    dataDir,
    secretsFile: path.join(dataDir, 'secrets.json'),
    clientDir: path.join(dataDir, 'client'),
    allowedHosts: null,
  };
  app = createApp({ config, logger: createLogger({ sink: () => undefined }) });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const appAddress = app.server.address();
  const appPort = typeof appAddress === 'object' && appAddress ? appAddress.port : 0;
  appOrigin = `http://127.0.0.1:${appPort}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.server.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  gate.release();
  requestLog.splice(0);
  window.localStorage.clear();
});

function savedProfile(): ApiProfile {
  return {
    id: 'profile-saved-stream',
    name: 'Saved streaming profile',
    baseUrl: upstreamUrl,
    modelId: 'mock-model',
    systemPrompt: '',
    timeoutMs: 30_000,
    credentialStorage: 'session',
    defaultParams: { ...DEFAULT_INFERENCE_PARAMS, stream: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tools: structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
  };
}

/** Resolve same-origin relative URLs against the real backend. */
function installSameOriginFetch(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return realFetch(`${appOrigin}${input}`, init);
    }
    return realFetch(input as RequestInfo, init);
  });
}

function header(): HTMLElement {
  return document.querySelector('header') as HTMLElement;
}

async function openSettings(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(within(header()).getByRole('button', { name: /^settings$/i }));
  return screen.findByRole('dialog', { name: /^settings$/i });
}

async function closeSettings(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = screen.getByRole('dialog', { name: /^settings$/i });
  await user.click(within(dialog).getByRole('button', { name: /close settings/i }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

async function createStreamingProfile(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await openSettings(user);
  await user.click(await within(dialog).findByRole('button', { name: /add profile/i }));
  await user.type(within(dialog).getByLabelText(/display name/i), 'Streaming test');
  await user.clear(within(dialog).getByLabelText(/base url/i));
  await user.type(within(dialog).getByLabelText(/base url/i), upstreamUrl);
  await user.type(within(dialog).getByLabelText(/api key/i), 'stream-test-key');

  await user.click(within(dialog).getByRole('button', { name: /test connection/i }));
  await within(dialog).findByText(/^connected$/i, undefined, { timeout: 15_000 });
  await user.click(within(dialog).getByRole('button', { name: /save profile/i }));
  await waitFor(() => expect(screen.queryByLabelText(/display name/i)).toBeNull());

  // Verify streaming against the real probe, then enable the stream switch.
  await user.click(within(dialog).getByRole('tab', { name: /^inference$/i }));
  await user.click(await within(dialog).findByRole('button', { name: /verify streaming support/i }));
  await within(dialog).findByText(/^streaming verified$/i, undefined, { timeout: 15_000 });
  const streamSwitch = within(dialog).getByRole('checkbox', { name: /stream the answer/i });
  expect(streamSwitch).not.toBeDisabled();
  await user.click(streamSwitch);
  await user.click(within(dialog).getByRole('button', { name: /save parameters/i }));

  await closeSettings(user);
}

async function sendMessage(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  const sidebar = screen.getByRole('complementary', { name: /conversations/i });
  await user.click(within(sidebar).getByRole('button', { name: /^new conversation$/i }));
  await user.type(await screen.findByLabelText(/^message$/i), text);
  await user.click(screen.getByRole('button', { name: /^send$/i }));
}

async function withinTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not happen within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('visible incremental streaming through the real application', () => {
  it('renders the first delta while the answer is still being generated', async () => {
    window.localStorage.clear();
    gate = createGate();
    installSameOriginFetch();
    const user = userEvent.setup();
    render(
      <AppProvider>
        <App />
      </AppProvider>,
    );

    await createStreamingProfile(user);
    await sendMessage(user, GATED_PROMPT);

    // The head must become visible while the upstream still holds the rest.
    await withinTimeout(
      waitFor(() => expect(document.body.textContent).toContain(ANSWER_HEAD), { timeout: 10_000 }),
      12_000,
      'the first streamed delta appearing in the DOM',
    );
    expect(gate.opened).toBe(false);
    expect(document.body.textContent).not.toContain(ANSWER_TAIL);
    expect(screen.getByText(/still writing/i)).toBeInTheDocument();

    // Something in the chain must really have asked for a stream.
    const streamingChat = requestLog.filter((entry) => entry.path === '/v1/chat/completions' && entry.stream);
    expect(streamingChat.length).toBeGreaterThan(0);

    gate.release();

    await waitFor(() => expect(document.body.textContent).toContain(ANSWER_TAIL), { timeout: 10_000 });
    await waitFor(() => expect(screen.queryByText(/still writing/i)).toBeNull());

    // The assembled answer is complete, ordered and not duplicated.
    const assistantText = document.body.textContent ?? '';
    expect(assistantText.split(ANSWER_HEAD)).toHaveLength(2);
    expect(assistantText.indexOf(ANSWER_HEAD)).toBeLessThan(assistantText.indexOf(ANSWER_TAIL));
    expect(assistantText).toContain(`${ANSWER_HEAD}${ANSWER_TAIL}`);
  }, 60_000);

  it('uses an ordinary request when the saved streaming preference is unverified, and says why', async () => {
    const saved = savedProfile();
    window.localStorage.setItem(STORAGE_KEYS.profiles, JSON.stringify([saved]));
    window.localStorage.setItem(
      STORAGE_KEYS.preferences,
      JSON.stringify({ activeProfileId: saved.id, activeConversationId: null, theme: 'system', sendOnEnter: true }),
    );
    gate = createGate();
    installSameOriginFetch();
    const user = userEvent.setup();
    render(
      <AppProvider>
        <App />
      </AppProvider>,
    );

    await sendMessage(user, 'A plain answer please');

    await waitFor(() => expect(document.body.textContent).toContain('OK'), { timeout: 10_000 });
    const chatRequests = requestLog.filter((entry) => entry.path === '/v1/chat/completions');
    expect(chatRequests.length).toBeGreaterThan(0);
    // The preference is saved, but this browser session never verified
    // streaming, so no server-sent-event request may be made.
    expect(chatRequests.every((entry) => !entry.stream)).toBe(true);
    // The interface says what happened instead of leaving the user to wonder
    // why the answer appeared in one piece.
    expect(document.body.textContent).toContain(
      'Streaming is enabled for this profile, but this browser session has not verified it',
    );
  }, 60_000);
});
