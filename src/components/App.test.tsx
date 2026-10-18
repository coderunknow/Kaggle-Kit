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
  let chatIndex = 0;

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
      return jsonResponse({
        ok: true,
        baseUrl: 'http://127.0.0.1:8000/v1',
        modelId: 'mock-model',
        stages: [
          { stage: 'models', status: 'ok', message: 'Model list retrieved (1 model(s)).' },
          { stage: 'inference', status: 'ok', message: 'A real chat completion was returned.' },
        ],
        capabilities: { streamingVerified: false, reasoningEffortSupported: false, notes: [] },
      });
    }

    if (url === '/api/proxy/probe-stream') {
      return jsonResponse({ supported: false, detail: 'The endpoint answered without an event stream.' });
    }

    if (url === '/api/secrets') {
      return jsonResponse({ ok: true });
    }

    if (url === '/api/proxy/chat') {
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

function renderApp() {
  return render(
    <AppProvider>
      <App />
    </AppProvider>,
  );
}

/** Create a profile through the settings UI. */
async function createProfile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(header()).getByRole('button', { name: /settings/i }));
  await user.click(await screen.findByRole('button', { name: /add profile/i }));

  await user.type(screen.getByLabelText(/display name/i), 'Kaggle T4');
  await user.clear(screen.getByLabelText(/base url/i));
  await user.type(screen.getByLabelText(/base url/i), 'http://127.0.0.1:8000');
  await user.type(screen.getByLabelText(/api key/i), API_KEY);

  await user.click(screen.getByRole('button', { name: /test connection/i }));
  await screen.findByText(/connection works/i);

  await user.click(screen.getByRole('button', { name: /save profile/i }));
  await waitFor(() => expect(screen.queryByLabelText(/display name/i)).toBeNull());
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

    await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));
    const composer = await screen.findByLabelText(/^message$/i);

    await user.type(composer, 'Hello there');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

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
    await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));
    await user.type(await screen.findByLabelText(/^message$/i), 'Hello there');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

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
    await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));
    await user.type(await screen.findByLabelText(/^message$/i), 'First question');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
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

  it('keeps the key in the local proxy secret store in the server mode', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(within(header()).getByRole('button', { name: /settings/i }));
    await user.click(await screen.findByRole('button', { name: /add profile/i }));

    await user.type(screen.getByLabelText(/display name/i), 'Proxy key');
    await user.clear(screen.getByLabelText(/base url/i));
    await user.type(screen.getByLabelText(/base url/i), 'http://127.0.0.1:8000');
    await user.selectOptions(screen.getByLabelText(/where the key is kept/i), 'server');
    await user.type(screen.getByLabelText(/api key/i), API_KEY);

    await user.click(screen.getByRole('button', { name: /save profile/i }));
    await waitFor(() => expect(screen.queryByLabelText(/display name/i)).toBeNull());

    const secretCall = calls.find((call) => call.url === '/api/secrets');
    expect(secretCall).toBeDefined();
    expect(secretCall?.body).toMatchObject({ apiKey: API_KEY });

    // The browser sends the reference, not the key itself.
    await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));
    await user.type(await screen.findByLabelText(/^message$/i), 'Hello there');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
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
    await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));
    await user.type(await screen.findByLabelText(/^message$/i), 'Hello there');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

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
    await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));
    await user.type(await screen.findByLabelText(/^message$/i), 'Remember this');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await screen.findByRole('alert');

    // The user message survives the failure.
    expect(screen.getAllByText('Remember this').length).toBeGreaterThan(0);

    const stored = window.localStorage.getItem('kaggle-kit.conversations.v1') ?? '';
    expect(stored).toContain('Remember this');
    expect(stored).not.toContain(API_KEY);
    expect(window.localStorage.getItem('kaggle-kit.browser-keys.v1')).toBe('{}');
  });

  it('renames and deletes conversations', async () => {
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);
    await user.click(within(sidebar()).getByRole('button', { name: /^new conversation$/i }));
    await user.type(await screen.findByLabelText(/^message$/i), 'First message');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await screen.findByText('Hello from the model');

    const list = screen.getByRole('list', { name: '' }) ?? document.body;
    const renameButton = screen.getByRole('button', { name: /rename/i });
    await user.click(renameButton);

    const input = screen.getByLabelText(/conversation title/i);
    await user.clear(input);
    await user.type(input, 'Renamed conversation');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByText('Renamed conversation')).toBeTruthy());

    const deleteButton = screen.getByRole('button', { name: /delete renamed conversation/i });
    await user.click(deleteButton);

    await waitFor(() => expect(screen.queryByText('Renamed conversation')).toBeNull());
    expect(list).toBeTruthy();
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
                stage: 'models',
                status: 'failed',
                message: 'The server rejected the API key (HTTP 401/403).',
                httpStatus: 401,
              },
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

    await user.click(within(header()).getByRole('button', { name: /settings/i }));
    await user.click(await screen.findByRole('button', { name: /add profile/i }));
    await user.type(screen.getByLabelText(/display name/i), 'Kaggle T4');
    await user.clear(screen.getByLabelText(/base url/i));
    await user.type(screen.getByLabelText(/base url/i), 'http://127.0.0.1:8000');
    await user.type(screen.getByLabelText(/api key/i), API_KEY);

    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await screen.findByText(/connection failed/i);
    expect(screen.getAllByText(/rejected the api key/i).length).toBeGreaterThan(0);
  });

  it('shows the active model and the profile in the header', async () => {
    const user = userEvent.setup();
    renderApp();

    await createProfile(user);

    expect(within(header()).getByText(/Kaggle T4/)).toBeTruthy();
    expect(within(header()).getByText(/mock-model/)).toBeTruthy();
  });
});
