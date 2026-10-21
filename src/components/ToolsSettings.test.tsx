// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_INFERENCE_PARAMS } from '../../shared/api/requests';
import { DEFAULT_TOOL_PROFILE_SETTINGS } from '../../shared/tools/types';
import type { ApiProfile } from '../../shared/domain';
import { AppProvider } from '../state/AppProvider';
import { initialState } from '../state/appState';
import { ToolsSettings } from './ToolsSettings';

const profile: ApiProfile = {
  id: 'profile-1',
  name: 'Test profile',
  baseUrl: 'http://127.0.0.1:8000/v1',
  modelId: 'mock-model',
  systemPrompt: '',
  timeoutMs: 10_000,
  credentialStorage: 'session',
  defaultParams: { ...DEFAULT_INFERENCE_PARAMS },
  tools: structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderSettings() {
  return render(
    <AppProvider initialAppState={{
      ...initialState,
      profiles: [profile],
      preferences: { ...initialState.preferences, activeProfileId: profile.id },
    }}>
      <ToolsSettings />
    </AppProvider>,
  );
}

describe('profile tool settings', () => {
  let calls: Array<{ url: string; method: string; body?: string }>;

  beforeEach(() => {
    window.localStorage.clear();
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.startsWith('/api/tools/profile?')) {
        return new Response(JSON.stringify({ settings: DEFAULT_TOOL_PROFILE_SETTINGS }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/tools/capability') {
        return new Response(JSON.stringify({
          status: 'failed_verification',
          detail: 'The harmless native function probe did not verify tool calls. Ordinary chat remains available.',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ settings: DEFAULT_TOOL_PROFILE_SETTINGS }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts disabled and reports only the result of the harmless native probe', async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(await screen.findByText('Tool calling for Test profile')).toBeTruthy();
    expect(screen.getByText(/Ordinary chat continues to work without tool support/i)).toBeTruthy();
    const enable = screen.getByRole('checkbox', { name: /enable the server-side tool loop/i });
    expect(enable).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: /verify native tool calling/i }));
    await waitFor(() => expect(screen.getByText('failed_verification')).toBeTruthy());
    expect(screen.getAllByText(/did not verify tool calls/i)).toHaveLength(2);
    const probe = calls.find((call) => call.url === '/api/tools/capability');
    expect(probe?.method).toBe('POST');
    expect(probe?.url).not.toContain('secret');
    expect(JSON.parse(probe?.body ?? '{}')).toMatchObject({ model: 'mock-model', baseUrl: profile.baseUrl });
  });
});

describe('Basic built-in tools', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('requires an explicit grant and save, without configuring providers, Python or MCP', async () => {
    window.localStorage.clear();
    const writes: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body) writes.push(body);
      return new Response(JSON.stringify({ settings: body?.settings ?? DEFAULT_TOOL_PROFILE_SETTINGS }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const user = userEvent.setup();
    render(<AppProvider initialAppState={{ ...initialState, profiles: [profile], preferences: { ...initialState.preferences, activeProfileId: profile.id } }}><ToolsSettings advanced={false} /></AppProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: /allow reviewed keyless/i })).toBeEnabled());
    expect(screen.queryByRole('textbox', { name: /digest-pinned/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /allow reviewed keyless/i }));
    expect(writes).toEqual([]);
    expect(screen.getByText(/7 tool\(s\) selected/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /save tool settings/i }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ settings: { enabled: true, web: { provider: 'disabled' }, code: { provider: 'disabled' }, mcpServers: [], httpTools: [] } });
    expect(JSON.stringify(writes)).not.toContain('web_search');
    expect(JSON.stringify(writes)).not.toContain('code_execute');
  });
});
