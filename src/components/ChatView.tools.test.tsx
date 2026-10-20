// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_INFERENCE_PARAMS } from '../../shared/api/requests';
import type { ApiProfile, Conversation } from '../../shared/domain';
import { DEFAULT_TOOL_PROFILE_SETTINGS } from '../../shared/tools/types';
import { STORAGE_KEYS } from '../lib/storage';
import { AppProvider, useApp } from '../state/AppProvider';
import { initialState } from '../state/appState';
import { ChatView } from './ChatView';

const profile: ApiProfile = {
  id: 'profile-1',
  name: 'Tool profile',
  baseUrl: 'http://127.0.0.1:8000/v1',
  modelId: 'mock-model',
  systemPrompt: '',
  timeoutMs: 10_000,
  credentialStorage: 'session',
  defaultParams: { ...DEFAULT_INFERENCE_PARAMS },
  tools: {
    ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
    enabled: true,
    allowedTools: ['calculator_calculate', 'files_list'],
    limits: { ...DEFAULT_TOOL_PROFILE_SETTINGS.limits, maxRounds: 4 },
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const conversation: Conversation = {
  id: 'conversation-1',
  title: 'Tool conversation',
  profileId: profile.id,
  messages: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function StateProbe() {
  const { state } = useApp();
  return <output data-testid="app-state">{JSON.stringify(state.conversations[0] ?? {})}</output>;
}

function ConnectedChat({ profileForChat }: { profileForChat: ApiProfile }) {
  const { state } = useApp();
  const activeConversation = state.conversations.find((entry) => entry.id === conversation.id);
  return (
    <ChatView
      conversation={activeConversation}
      profile={profileForChat}
      pending={false}
      connectionState="connected"
      onSend={vi.fn()}
      onCancel={vi.fn()}
      onToolApproval={vi.fn()}
      onCopy={async () => true}
      onEdit={vi.fn()}
      onRetry={vi.fn()}
      onResend={vi.fn()}
      onRegenerate={vi.fn()}
      onOpenSettings={vi.fn()}
      composerRef={createRef<HTMLTextAreaElement>()}
    />
  );
}

function renderChat(profileForChat = profile) {
  return render(
    <AppProvider initialAppState={{
      ...initialState,
      profiles: [profileForChat],
      conversations: [conversation],
      preferences: { ...initialState.preferences, activeProfileId: profileForChat.id, activeConversationId: conversation.id },
    }}>
      <ConnectedChat profileForChat={profileForChat} />
      <StateProbe />
    </AppProvider>,
  );
}

describe('conversation tool controls and uploads', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/tools/files?')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lets a conversation narrow the profile allowlist and tighten its round budget', async () => {
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByText('Conversation tools and privacy'));
    const calculate = screen.getByRole('checkbox', { name: 'calculator_calculate' });
    expect(calculate).toBeChecked();
    await user.click(calculate);
    await waitFor(() => {
      const saved = JSON.parse(screen.getByTestId('app-state').textContent ?? '{}') as Conversation;
      expect(saved.toolSettings?.toolIds).toEqual(['files_list']);
    });

    const rounds = screen.getByRole('spinbutton', { name: /maximum tool rounds in this conversation/i });
    await user.clear(rounds);
    await user.type(rounds, '99');
    await waitFor(() => {
      const saved = JSON.parse(screen.getByTestId('app-state').textContent ?? '{}') as Conversation;
      expect(saved.toolSettings?.maxRounds).toBe(4);
    });

    const persist = screen.getByRole('checkbox', { name: /persist tool history for this conversation/i });
    expect(persist).not.toBeChecked();
    await user.click(persist);
    await waitFor(() => {
      const saved = JSON.parse(screen.getByTestId('app-state').textContent ?? '{}') as Conversation;
      expect(saved.toolSettings?.historyPersistence).toBe(true);
      expect(saved.toolHistoryPersistence).toBe(true);
    });
  });

  it('uploads a selected file through the proxy and keeps only its metadata in browser history', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/tools/files?')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/tools/files/upload') {
        return new Response(JSON.stringify({ file: {
          id: 'opaque-file-12345678', name: 'notes.txt', mediaType: 'text/plain', size: 28, extractedCharacters: 28,
        } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const user = userEvent.setup();
    const { container } = renderChat({
      ...profile,
      tools: { ...profile.tools!, allowedTools: ['files_list'] },
    });
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await user.upload(fileInput as HTMLInputElement, new File(['TOP SECRET DOCUMENT CONTENT'], 'notes.txt', { type: 'text/plain' }));

    expect(await screen.findByText('notes.txt')).toBeTruthy();
    await waitFor(() => {
      const saved = window.localStorage.getItem(STORAGE_KEYS.conversations) ?? '';
      expect(saved).toContain('opaque-file-12345678');
      expect(saved).not.toContain('TOP SECRET DOCUMENT CONTENT');
    });
  });
});
