// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { AppProvider } from '../state/AppProvider';

const API_KEY = 'test-key-not-to-be-persisted';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

interface FetchMockOptions {
  chatResponses?: Array<{ status: number; body: unknown } | 'hang'>;
  /** Answers for consecutive /api/proxy/test calls. */
  testResponses?: unknown[];
  /** Answer the chat request with an event stream. */
  streaming?: boolean;
}

const calls: RecordedCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchMock(options: FetchMockOptions = {}): void {
  const chatResponses = [...(options.chatResponses ?? [])];
  const testResponses = [...(options.testResponses ?? [])];
  let chatIndex = 0;
  let testIndex = 0;

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url === '/api/health') {
      return jsonResponse({ ok: true });
    }

    if (url === '/api/proxy/models') {
      return jsonResponse({ models: ['mock-model', 'mock-model-2'] });
    }

    if (url === '/api/proxy/test') {
      const next = testResponses[testIndex];
      testIndex += 1;
      if (next !== undefined) return jsonResponse(next);

      return jsonResponse({
        ok: true,
        baseUrl: 'http://127.0.0.1:8000/v1',
        requestedBaseUrl: 'http://127.0.0.1:8000',
        baseUrlChanged: true,
        modelId: 'mock-model',
        stages: [
          { stage: 'transport', status: 'ok', message: 'The endpoint answered the model list request.' },
          { stage: 'auth', status: 'ok', message: 'The endpoint accepted the API key.' },
          { stage: 'models', status: 'ok', message: 'Model list retrieved (2 model(s)).' },
          { stage: 'model', status: 'ok', message: 'The endpoint advertises the configured model mock-model.' },
          { stage: 'inference', status: 'ok', message: 'A real chat completion was returned.' },
          { stage: 'streaming', status: 'not_run', message: 'Not tested.' },
        ],
        testedAt: '2026-10-19T00:00:00.000Z',
        capabilities: {
          streamingVerified: Boolean(options.streaming),
          reasoningEffortSupported: false,
          notes: [],
        },
      });
    }

    if (url === '/api/proxy/probe-stream') {
      return jsonResponse({ supported: false, detail: 'The endpoint answered without an event stream.' });
    }

    if (url === '/api/secrets') {
      return jsonResponse({ ok: true });
    }

    if (url === '/api/proxy/chat') {
      if (options.streaming) {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
            );
            // The stream stays open until the request is aborted.
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      const next = chatResponses[chatIndex] ?? { status: 200, body: defaultCompletion() };
      chatIndex += 1;

      if (next === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }

      return jsonResponse(next.body, next.status);
    }

    return jsonResponse({ error: { message: 'unknown route' } }, 404);
  };

  vi.stubGlobal('fetch', impl);
}

function defaultCompletion(content = 'Hello from the model'): unknown {
  return {
    response: {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'mock-model',
      choices: [
        { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
  };
}

function header(): HTMLElement {
  return document.querySelector('header') as HTMLElement;
}

function sidebar(): HTMLElement {
  return screen.getByRole('complementary', { name: /conversations/i });
}

/** The settings drawer, which every profile test has to scope its queries to. */
function drawer(): HTMLElement {
  return screen.getByRole('dialog', { name: /^settings$/i });
}

function renderApp() {
  return render(
    <AppProvider>
      <App />
    </AppProvider>,
  );
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(header()).getByRole('button', { name: /^settings$/i }));
  await screen.findByRole('dialog', { name: /^settings$/i });
  return within(drawer());
}

async function closeSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(drawer()).getByRole('button', { name: /close settings/i }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

/** Create a profile through the settings UI. Leaves the drawer closed. */
async function createProfile(user: ReturnType<typeof userEvent.setup>) {
  const panel = await openSettings(user);
  await user.click(await panel.findByRole('button', { name: /add profile/i }));

  await user.clear(panel.getByLabelText(/display name/i));
  await user.type(panel.getByLabelText(/display name/i), 'Kaggle T4');
  await user.clear(panel.getByLabelText(/base url/i));
  await user.type(panel.getByLabelText(/base url/i), 'http://127.0.0.1:8000');
  await user.type(panel.getByLabelText(/api key/i), API_KEY);

  await user.click(panel.getByRole('button', { name: /test connection/i }));
  await panel.findByText(/^connected$/i);

  await user.click(panel.getByRole('button', { name: /save profile/i }));
  await waitFor(() => expect(screen.queryByLabelText(/display name/i)).toBeNull());

  await closeSettings(user);
}

async function startConversation(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));
  const composer = await screen.findByLabelText(/^message$/i);
  await user.type(composer, text);
  await user.click(screen.getByRole('button', { name: /^send$/i }));
}

describe('the chat interface', () => {
  beforeEach(() => {
    window.localStorage.clear();
    calls.length = 0;
    installFetchMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('runs a real multi turn conversation through the proxy', async () => {
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);
    await startConversation(user, 'Hello there');

    await screen.findByText('Hello from the model');

    const chatCall = calls.find((call) => call.url === '/api/proxy/chat');
    expect(chatCall).toBeDefined();
    expect(chatCall?.method).toBe('POST');
    expect(chatCall?.url).not.toContain(API_KEY);

    const payload = chatCall?.body as {
      baseUrl: string;
      apiKey?: string;
      model: string;
      messages: { role: string; content: string }[];
      params: { maxTokens: number; temperature: number; topP: number; stream: boolean };
    };

    expect(payload.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(payload.apiKey).toBe(API_KEY);
    expect(payload.model).toBe('mock-model');
    expect(payload.messages).toEqual([{ role: 'user', content: 'Hello there' }]);
    expect(payload.params.stream).toBe(false);
    expect(payload.params.maxTokens).toBe(1024);

    // A second turn keeps the previous context.
    await user.type(screen.getByLabelText(/^message$/i), 'And now?');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      const chatCalls = calls.filter((call) => call.url === '/api/proxy/chat');
      expect(chatCalls).toHaveLength(2);
    });

    const secondPayload = calls.filter((call) => call.url === '/api/proxy/chat')[1]?.body as {
      messages: { role: string; content: string }[];
    };
    expect(secondPayload.messages).toEqual([
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hello from the model' },
      { role: 'user', content: 'And now?' },
    ]);
  });

  it('shows an actionable error and can retry a failed request', async () => {
    installFetchMock({
      chatResponses: [
        {
          status: 502,
          body: {
            error: {
              message: 'The model server is not reachable.',
              kind: 'network',
              hint: 'Check that the server is running.',
            },
          },
        },
        { status: 200, body: defaultCompletion('Recovered answer') },
      ],
    });

    const user = userEvent.setup();
    renderApp();

    await createProfile(user);
    await startConversation(user, 'Hello there');

    const errorBox = await screen.findByRole('alert');
    expect(errorBox).toHaveTextContent('Connection failed');
    expect(errorBox).toHaveTextContent('The model server is not reachable.');
    expect(errorBox).toHaveTextContent('Check that the server is running.');
    expect(errorBox).not.toHaveTextContent(API_KEY);

    await user.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Recovered answer');
  });

  it('resends a user message and truncates the conversation', async () => {
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);
    await startConversation(user, 'First question');
    await screen.findByText('Hello from the model');

    await user.type(screen.getByLabelText(/^message$/i), 'Second question');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => {
      const chatCalls = calls.filter((call) => call.url === '/api/proxy/chat');
      expect(chatCalls).toHaveLength(2);
    });

    // Resend the first user message: the conversation restarts from there.
    const resend = screen.getAllByRole('button', { name: /resend/i })[0];
    await user.click(resend as HTMLElement);

    await waitFor(() => {
      const chatCalls = calls.filter((call) => call.url === '/api/proxy/chat');
      expect(chatCalls).toHaveLength(3);
    });

    const payload = calls.filter((call) => call.url === '/api/proxy/chat')[2]?.body as {
      messages: { role: string; content: string }[];
    };
    expect(payload.messages).toEqual([{ role: 'user', content: 'First question' }]);
  });

  it('invalidates an editor test immediately when the typed credential changes', async () => {
    const user = userEvent.setup();
    renderApp();
    const panel = await openSettings(user);
    await user.click(await panel.findByRole('button', { name: /add profile/i }));
    await user.type(panel.getByLabelText(/api key/i), API_KEY);
    await user.click(panel.getByRole('button', { name: /test connection/i }));
    await panel.findByText(/^connected$/i);
    await user.type(panel.getByLabelText(/api key/i), '-rotated');
    expect(panel.queryByText(/^connected$/i)).toBeNull();
    expect(panel.getByText(/form changed since the last test/i)).toBeTruthy();
  });

  it('preserves a matching inference test when saving a tested replacement credential', async () => {
    const user = userEvent.setup();
    renderApp();
    await createProfile(user);
    const panel = await openSettings(user);
    await user.click(panel.getByRole('button', { name: /^edit$/i }));
    await user.type(panel.getByLabelText(/api key/i), 'rotated-test-key');
    await user.click(panel.getByRole('button', { name: /test connection/i }));
    await panel.findByText(/^connected$/i);
    await user.click(panel.getByRole('button', { name: /save profile/i }));
    await closeSettings(user);
    await openSettings(user);
    expect(within(drawer()).getByText(/^connected$/i)).toBeTruthy();
  });

  it('explains empty model discovery without inventing a model or a connected status', async () => {
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => String(input) === '/api/proxy/models'
      ? jsonResponse({ models: [] }) : original(input, init));
    const user = userEvent.setup();
    renderApp();
    const panel = await openSettings(user);
    await user.click(await panel.findByRole('button', { name: /add profile/i }));
    await user.click(panel.getByRole('button', { name: /discover models/i }));
    await panel.findByText(/endpoint returned no model IDs/i);
    expect(panel.getByLabelText(/^model id$/i)).toHaveValue('');
    expect(panel.queryByText(/^connected$/i)).toBeNull();
  });

  it('keeps the key in the local proxy secret store in the server mode', async () => {
    const user = userEvent.setup();
    renderApp();

    const panel = await openSettings(user);
    await user.click(await panel.findByRole('button', { name: /add profile/i }));

    await user.clear(panel.getByLabelText(/display name/i));
    await user.type(panel.getByLabelText(/display name/i), 'Proxy key');
    await user.clear(panel.getByLabelText(/base url/i));
    await user.type(panel.getByLabelText(/base url/i), 'http://127.0.0.1:8000');
    await user.selectOptions(panel.getByLabelText(/where the key is kept/i), 'server');
    await user.type(panel.getByLabelText(/api key/i), API_KEY);

    await user.click(panel.getByRole('button', { name: /save profile/i }));
    await waitFor(() => expect(screen.queryByLabelText(/display name/i)).toBeNull());

    const secretCall = calls.find((call) => call.url === '/api/secrets');
    expect(secretCall).toBeDefined();
    expect(secretCall?.body).toMatchObject({ apiKey: API_KEY });

    await closeSettings(user);
    await startConversation(user, 'Hello there');
    await screen.findByText('Hello from the model');

    const chatCall = calls.find((call) => call.url === '/api/proxy/chat');
    const payload = chatCall?.body as { apiKey?: string; secretRef?: string };
    expect(payload.apiKey).toBeUndefined();
    expect(payload.secretRef).toBeTruthy();
  });

  it('cancels an in flight request', async () => {
    installFetchMock({ chatResponses: ['hang'] });

    const user = userEvent.setup();
    renderApp();

    await createProfile(user);
    await startConversation(user, 'Hello there');

    await screen.findByRole('button', { name: /stop/i });
    await user.click(screen.getByRole('button', { name: /stop/i }));

    await screen.findByText(/request cancelled/i);
  });

  it('keeps the conversation when a request fails and stores it without the key', async () => {
    installFetchMock({
      chatResponses: [{ status: 500, body: { error: { message: 'boom', kind: 'server' } } }],
    });

    const user = userEvent.setup();
    renderApp();

    await createProfile(user);
    await startConversation(user, 'Remember this');

    await screen.findByRole('alert');

    // The user message survives the failure.
    expect(screen.getAllByText('Remember this').length).toBeGreaterThan(0);

    // Conversation writes are throttled, so the failure has to reach the
    // store eventually rather than synchronously.
    await waitFor(() => {
      const stored = window.localStorage.getItem('kaggle-kit.conversations.v1') ?? '';
      expect(stored).toContain('Remember this');
      expect(stored).not.toContain(API_KEY);
    });
    expect(window.localStorage.getItem('kaggle-kit.browser-keys.v1')).toBe('{}');
  });

  it('renames and deletes conversations', async () => {
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);
    await startConversation(user, 'First message');
    await screen.findByText('Hello from the model');

    await user.click(screen.getByRole('button', { name: /^rename first message$/i }));

    const input = screen.getByLabelText(/conversation title/i);
    await user.clear(input);
    await user.type(input, 'Renamed conversation');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getAllByText('Renamed conversation').length).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: /^delete renamed conversation$/i }));
    await user.click(screen.getByRole('button', { name: /^confirm delete renamed conversation$/i }));

    await waitFor(() => expect(screen.queryByText('Renamed conversation')).toBeNull());
  });

  it('reports a failing connection test with the reason', async () => {
    const failing = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      if (url === '/api/proxy/test') {
        return jsonResponse(
          {
            ok: false,
            baseUrl: 'http://127.0.0.1:8000/v1',
            stages: [
              {
                stage: 'transport',
                status: 'ok',
                message: 'The endpoint answered with HTTP 401.',
                httpStatus: 401,
              },
              {
                stage: 'auth',
                status: 'failed',
                message: 'The server rejected the API key (HTTP 401/403).',
                httpStatus: 401,
              },
              {
                stage: 'models',
                status: 'failed',
                message: 'The server rejected the API key (HTTP 401/403).',
                httpStatus: 401,
              },
              { stage: 'model', status: 'not_run', message: 'Not checked.' },
              { stage: 'inference', status: 'not_run', message: 'Not checked.' },
              { stage: 'streaming', status: 'not_run', message: 'Not tested.' },
            ],
            errorKind: 'auth',
            errorMessage: 'The server rejected the API key (HTTP 401/403).',
            errorHint: 'Check the key and restart the server if it was rotated.',
          },
          200,
        );
      }
      return jsonResponse({ ok: true });
    };
    vi.stubGlobal('fetch', failing);

    const user = userEvent.setup();
    renderApp();

    const panel = await openSettings(user);
    await user.click(await panel.findByRole('button', { name: /add profile/i }));
    await user.clear(panel.getByLabelText(/display name/i));
    await user.type(panel.getByLabelText(/display name/i), 'Kaggle T4');
    await user.clear(panel.getByLabelText(/base url/i));
    await user.type(panel.getByLabelText(/base url/i), 'http://127.0.0.1:8000');
    await user.type(panel.getByLabelText(/api key/i), API_KEY);

    await user.click(panel.getByRole('button', { name: /test connection/i }));

    await panel.findAllByText(/connection failed/i);
    expect(panel.getAllByText(/rejected the api key/i).length).toBeGreaterThan(0);
  });

  it('lets the user type a model ID that the server did not report', async () => {
    const user = userEvent.setup();
    renderApp();

    const panel = await openSettings(user);
    await user.click(await panel.findByRole('button', { name: /add profile/i }));

    await user.clear(panel.getByLabelText(/display name/i));
    await user.type(panel.getByLabelText(/display name/i), 'Kaggle T4');
    await user.clear(panel.getByLabelText(/base url/i));
    await user.type(panel.getByLabelText(/base url/i), 'http://127.0.0.1:8000');
    await user.type(panel.getByLabelText(/api key/i), API_KEY);

    await user.click(panel.getByRole('button', { name: /discover models/i }));
    await waitFor(() => expect(panel.getByLabelText(/model id/i).tagName).toBe('SELECT'));

    await user.selectOptions(panel.getByLabelText(/model id/i), '__custom__');

    const manual = panel.getByLabelText(/model id \(typed by hand\)/i);
    await user.type(manual, 'my-own-model');

    await user.click(panel.getByRole('button', { name: /save profile/i }));
    await waitFor(() => expect(screen.queryByLabelText(/display name/i)).toBeNull());
    await closeSettings(user);

    expect(within(header()).getByText(/my-own-model/)).toBeTruthy();
  });

  it('shows the active model and the profile in the header', async () => {
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);

    expect(within(header()).getByText(/Kaggle T4/)).toBeTruthy();
    expect(within(header()).getByText(/mock-model/)).toBeTruthy();
  });

  it('uses the same cause label and message in the chat and in Settings', async () => {
    const message = 'The server rejected the API key (HTTP 401/403).';
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);

    installFetchMock({
      chatResponses: [
        {
          status: 502,
          body: {
            error: {
              message,
              kind: 'auth',
              hint: 'Check the key and restart the server if it was rotated.',
            },
          },
        },
      ],
      testResponses: [
        {
          ok: false,
          baseUrl: 'http://127.0.0.1:8000/v1',
          modelId: 'mock-model',
          stages: [
            { stage: 'transport', status: 'ok', message: 'The endpoint answered with HTTP 401.', httpStatus: 401 },
            { stage: 'auth', status: 'failed', message, httpStatus: 401 },
            { stage: 'models', status: 'failed', message, httpStatus: 401 },
            { stage: 'model', status: 'not_run', message: 'Not checked.' },
            { stage: 'inference', status: 'not_run', message: 'Not checked.' },
            { stage: 'streaming', status: 'not_run', message: 'Not tested.' },
          ],
          errorKind: 'auth',
          errorMessage: message,
          errorHint: 'Check the key and restart the server if it was rotated.',
        },
      ],
    });

    await startConversation(user, 'Hello there');
    const chatError = await screen.findByRole('alert');
    expect(chatError).toHaveTextContent('Authentication failed');
    expect(chatError).toHaveTextContent(message);

    const panel = await openSettings(user);
    const card = panel.getByRole('group', { name: /profile kaggle t4/i });
    await user.click(within(card).getByRole('button', { name: /^edit$/i }));
    await user.click(panel.getByRole('button', { name: /test connection/i }));

    const results = await panel.findAllByText(message);
    expect(results.length).toBeGreaterThan(0);
    expect(panel.getAllByText('Authentication failed').length).toBeGreaterThan(0);
  });

  it('does not attach a failing draft test to the saved profile', async () => {
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);

    // The draft test fails; the profile that was already saved keeps its
    // verified state until its own configuration is tested again.
    installFetchMock({
      testResponses: [
        {
          ok: false,
          baseUrl: 'http://127.0.0.1:9999/v1',
          modelId: '',
          stages: [
            { stage: 'transport', status: 'failed', message: 'The endpoint is not reachable.' },
            { stage: 'auth', status: 'not_run', message: 'Not checked.' },
            { stage: 'models', status: 'not_run', message: 'Not checked.' },
            { stage: 'model', status: 'not_run', message: 'Not checked.' },
            { stage: 'inference', status: 'not_run', message: 'Not checked.' },
            { stage: 'streaming', status: 'not_run', message: 'Not tested.' },
          ],
          errorKind: 'network',
          errorMessage: 'The endpoint is not reachable.',
          errorHint: 'Check the tunnel address and that the notebook is running.',
        },
      ],
    });

    const panel = await openSettings(user);
    const card = panel.getByRole('group', { name: /profile kaggle t4/i });
    await user.click(within(card).getByRole('button', { name: /^edit$/i }));

    const baseUrl = panel.getByLabelText(/base url/i);
    await user.clear(baseUrl);
    await user.type(baseUrl, 'http://127.0.0.1:9999');

    await user.click(panel.getByRole('button', { name: /test connection/i }));
    await panel.findAllByText(/connection failed/i);

    await user.click(panel.getByRole('button', { name: /close the editor/i }));
    await waitFor(() => expect(panel.queryByLabelText(/base url/i)).toBeNull());

    // The draft never overwrote the verified state of the saved profile.
    expect(within(card).getByText(/^connected$/i)).toBeTruthy();
    expect(within(header()).queryByText(/9999/)).toBeNull();
    expect(within(header()).getByRole('button', { name: /8000\/v1/ })).toBeTruthy();
  });

  it('requires a new test after the saved base URL changes', async () => {
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);

    const panel = await openSettings(user);
    const card = panel.getByRole('group', { name: /profile kaggle t4/i });
    await user.click(within(card).getByRole('button', { name: /^edit$/i }));

    const baseUrl = panel.getByLabelText(/base url/i);
    await user.clear(baseUrl);
    await user.type(baseUrl, 'http://127.0.0.1:8443');
    await user.click(panel.getByRole('button', { name: /save profile/i }));

    await waitFor(() => expect(panel.queryByLabelText(/display name/i)).toBeNull());
    const savedCard = panel.getByRole('group', { name: /profile kaggle t4/i });
    expect(within(savedCard).getByText(/not tested|test needed/i)).toBeTruthy();
    expect(within(savedCard).getByText(/8443\/v1/)).toBeTruthy();
    expect(within(header()).getByRole('button', { name: /8443\/v1/ })).toBeTruthy();
  });
});

describe('the recommended system prompt', () => {
  beforeEach(() => {
    window.localStorage.clear();
    calls.length = 0;
    installFetchMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is inserted from the profile editor and becomes the first message of the request', async () => {
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);

    const panel = await openSettings(user);
    await user.click(panel.getByRole('button', { name: /^edit$/i }));
    await user.click(panel.getByRole('checkbox', { name: /advanced mode/i }));
    await user.click(panel.getByRole('button', { name: /insert the recommended qwen prompt/i }));

    const textarea = panel.getByLabelText(/system prompt/i) as HTMLTextAreaElement;
    expect(textarea.value.startsWith('You are Qwen')).toBe(true);

    await user.click(panel.getByRole('button', { name: /save profile/i }));
    await waitFor(() => expect(screen.queryByLabelText(/display name/i)).toBeNull());
    await closeSettings(user);

    await startConversation(user, 'Explain what a hash table is');

    await waitFor(() => expect(calls.some((call) => call.url === '/api/proxy/chat')).toBe(true));

    const chat = calls.filter((call) => call.url === '/api/proxy/chat').at(-1);
    const messages = (chat?.body as { messages: Array<{ role: string; content: string }> }).messages;

    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content.startsWith('You are Qwen')).toBe(true);
    expect(messages[1]).toEqual({ role: 'user', content: 'Explain what a hash table is' });
    // The prompt is sent once, not repeated per turn.
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
  });

  it('sends no system message when the profile has no prompt', async () => {
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);
    await startConversation(user, 'Hello');

    await waitFor(() => expect(calls.some((call) => call.url === '/api/proxy/chat')).toBe(true));

    const chat = calls.filter((call) => call.url === '/api/proxy/chat').at(-1);
    const messages = (chat?.body as { messages: Array<{ role: string }> }).messages;
    expect(messages.some((message) => message.role === 'system')).toBe(false);
  });

});

describe('the chat surface', () => {
  beforeEach(() => {
    window.localStorage.clear();
    calls.length = 0;
    installFetchMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts a conversation from the landing view and sends the first message', async () => {
    const user = userEvent.setup();
    renderApp();
    await createProfile(user);

    // No conversation is selected, but the composer is usable.
    const composer = screen.getByLabelText(/^message$/i);
    await user.type(composer, 'First words');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await screen.findByText('Hello from the model');
    expect(calls.filter((call) => call.url === '/api/proxy/chat')).toHaveLength(1);
    expect(screen.getAllByText('First words').length).toBeGreaterThan(0);
  });

  it('fills the composer from a starter without sending anything', async () => {
    const user = userEvent.setup();
    renderApp();
    await createProfile(user);
    await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));

    await user.click(screen.getByRole('button', { name: /explain a concept/i }));

    const composer = screen.getByLabelText(/^message$/i) as HTMLTextAreaElement;
    expect(composer.value).toContain('hash table');
    expect(calls.some((call) => call.url === '/api/proxy/chat')).toBe(false);
  });

  it('keeps a draft when the page is reloaded', async () => {
    const user = userEvent.setup();
    const view = renderApp();
    await createProfile(user);
    await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));

    await user.type(screen.getByLabelText(/^message$/i), 'A draft worth keeping');
    expect(window.localStorage.getItem('kaggle-kit.drafts.v1')).toContain('A draft worth keeping');

    view.unmount();
    renderApp();

    const restored = await screen.findByLabelText(/^message$/i);
    await waitFor(() => expect((restored as HTMLTextAreaElement).value).toBe('A draft worth keeping'));
  });

  it('exports the active conversation as a Markdown download', async () => {
    const user = userEvent.setup();
    renderApp();
    await createProfile(user);
    await startConversation(user, 'Export this please');
    await screen.findByText('Hello from the model');

    const createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return 'blob:mock';
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });

    await user.click(screen.getByRole('button', { name: /export the conversation/i }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toContain('text/markdown');
    expect(downloaded.endsWith('.md')).toBe(true);
    expect(screen.getByText(/exported as markdown/i)).toBeTruthy();
  });

  it('sends only with Ctrl+Enter when the preference says so', async () => {
    window.localStorage.setItem(
      'kaggle-kit.prefs.v1',
      JSON.stringify({
        activeProfileId: null,
        activeConversationId: null,
        theme: 'system',
        sendOnEnter: false,
      }),
    );

    const user = userEvent.setup();
    renderApp();
    await createProfile(user);
    await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));

    const composer = screen.getByLabelText(/^message$/i);
    await user.type(composer, 'Modifier only');
    await user.keyboard('{Enter}');

    expect(calls.some((call) => call.url === '/api/proxy/chat')).toBe(false);
    expect((composer as HTMLTextAreaElement).value).toContain('Modifier only');

    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(calls.some((call) => call.url === '/api/proxy/chat')).toBe(true));
    await screen.findByText('Hello from the model');
  });

  it('finds a conversation by title from the sidebar search', async () => {
    const user = userEvent.setup();
    renderApp();
    await createProfile(user);

    for (let index = 0; index < 3; index += 1) {
      await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));
    }

    const search = await screen.findByLabelText(/search conversations/i);
    await user.type(search, 'alpha');
    expect(screen.getByText(/no conversation matches/i)).toBeTruthy();

    await user.clear(search);
    const rename = screen.getAllByRole('button', { name: /^rename new conversation$/i })[0]!;
    await user.click(rename);
    const input = screen.getByLabelText(/conversation title/i);
    await user.clear(input);
    await user.type(input, 'Alpha plan');
    await user.keyboard('{Enter}');

    await user.type(search, 'alpha');
    expect(within(sidebar()).getAllByText('Alpha plan').length).toBeGreaterThan(0);
    expect(within(sidebar()).queryByText(/no conversation matches/i)).toBeNull();
  });

  it('starts a new conversation with Alt+Shift+N and focuses the composer with Ctrl+/', async () => {
    const user = userEvent.setup();
    renderApp();
    await createProfile(user);

    await user.keyboard('{Alt>}{Shift>}n{/Shift}{/Alt}');
    await waitFor(() => {
      expect(within(sidebar()).getAllByRole('button', { name: /^rename new conversation$/i })).toHaveLength(1);
    });

    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{Control>}/{/Control}');
    expect(screen.getByLabelText(/^message$/i)).toHaveFocus();
  });

  it('switches the color theme without touching stored credentials', async () => {
    const user = userEvent.setup();
    renderApp();

    const themeButton = () =>
      screen.getByRole('button', { name: /switch to the (dark|light) theme/i });

    await user.click(themeButton());
    const first = document.documentElement.dataset.theme;
    expect(first === 'dark' || first === 'light').toBe(true);

    await user.click(themeButton());
    const second = document.documentElement.dataset.theme;
    expect(second).not.toBe(first);

    const prefs = JSON.parse(window.localStorage.getItem('kaggle-kit.prefs.v1') ?? '{}');
    expect(prefs.theme).toBe(second);
    expect(window.localStorage.getItem('kaggle-kit.browser-keys.v1')).toBe('{}');
  });
});
