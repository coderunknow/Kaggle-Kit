import { describe, expect, it } from 'vitest';

import { initialState, appReducer, type AppState } from './appState';
import type { ApiProfile, Conversation } from '../../shared/domain';

const profile: ApiProfile = {
  id: 'profile-1',
  name: 'Kaggle',
  baseUrl: 'http://127.0.0.1:8000/v1',
  modelId: 'mock-model',
  systemPrompt: '',
  timeoutMs: 120_000,
  credentialStorage: 'session',
  defaultParams: { maxTokens: 1024, temperature: 0.7, topP: 0.95, stream: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const conversation: Conversation = {
  id: 'conv-1',
  title: 'Hello',
  profileId: 'profile-1',
  messages: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function reduce(state: AppState, ...actions: Parameters<typeof appReducer>[1][]): AppState {
  return actions.reduce(appReducer, state);
}

const secondConversation: Conversation = {
  ...conversation,
  id: 'conv-2',
  title: 'Other',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

describe('appReducer', () => {
  it('patches a message without touching other conversations', () => {
    const first: Conversation = {
      ...conversation,
      updatedAt: '2026-01-03T00:00:00.000Z',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          status: 'pending',
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ],
    };

    const state = reduce(
      reduce(
        reduce(initialState, { type: 'conversations/upsert', conversation: first }),
        { type: 'conversations/upsert', conversation: secondConversation },
      ),
      {
        type: 'messages/patch',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        changes: { content: 'Hello' },
      },
    );

    const patched = state.conversations.find((item) => item.id === 'conv-1');
    const untouched = state.conversations.find((item) => item.id === 'conv-2');

    expect(patched?.messages[0]?.content).toBe('Hello');
    expect(untouched?.updatedAt).toBe(secondConversation.updatedAt);
    expect(untouched).toBe(secondConversation);
  });

  it('does not create a conversation for a late patch', () => {
    const state = reduce(initialState, {
      type: 'messages/patch',
      conversationId: 'missing',
      messageId: 'msg-1',
      changes: { content: 'late' },
    });

    expect(state).toBe(initialState);
  });

  it('adds and updates profiles', () => {
    let state = reduce(initialState, { type: 'profiles/upsert', profile });
    expect(state.profiles).toHaveLength(1);

    state = reduce(state, {
      type: 'profiles/upsert',
      profile: { ...profile, name: 'Renamed' },
    });
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]?.name).toBe('Renamed');
  });

  it('removes a profile together with its credentials and capabilities', () => {
    const state = reduce(
      reduce(
        reduce(initialState, { type: 'profiles/upsert', profile }),
        { type: 'keys/setSession', profileId: 'profile-1', apiKey: 'secret' },
        { type: 'keys/setBrowser', profileId: 'profile-1', apiKey: 'secret' },
        { type: 'profiles/select', id: 'profile-1' },
      ),
      { type: 'profiles/delete', id: 'profile-1' },
    );

    expect(state.profiles).toHaveLength(0);
    expect(state.sessionKeys['profile-1']).toBeUndefined();
    expect(state.browserKeys['profile-1']).toBeUndefined();
    expect(state.preferences.activeProfileId).toBeNull();
  });

  it('stores conversations and patches them without losing messages', () => {
    let state = reduce(initialState, { type: 'conversations/upsert', conversation });
    expect(state.conversations).toHaveLength(1);

    state = reduce(state, {
      type: 'conversations/patch',
      id: 'conv-1',
      changes: { title: 'Renamed' },
    });

    expect(state.conversations[0]?.title).toBe('Renamed');
    expect(state.conversations[0]?.messages).toHaveLength(0);
  });

  it('selects and deletes conversations', () => {
    let state = reduce(initialState, { type: 'conversations/upsert', conversation });
    state = reduce(state, { type: 'conversations/select', id: 'conv-1' });
    expect(state.preferences.activeConversationId).toBe('conv-1');

    state = reduce(state, { type: 'conversations/delete', id: 'conv-1' });
    expect(state.conversations).toHaveLength(0);
    expect(state.preferences.activeConversationId).toBeNull();
  });

  it('keeps session keys and browser keys apart', () => {
    let state = reduce(initialState, { type: 'keys/setSession', profileId: 'p', apiKey: 'a' });
    state = reduce(state, { type: 'keys/setBrowser', profileId: 'p', apiKey: 'b' });

    expect(state.sessionKeys.p).toBe('a');
    expect(state.browserKeys.p).toBe('b');

    state = reduce(state, { type: 'keys/clearSession', profileId: 'p' });
    expect(state.sessionKeys.p).toBeUndefined();
    expect(state.browserKeys.p).toBe('b');

    state = reduce(state, { type: 'keys/clearAll' });
    expect(state.browserKeys.p).toBeUndefined();
  });

  it('resets everything', () => {
    const state = reduce(
      reduce(initialState, { type: 'profiles/upsert', profile }, { type: 'keys/setSession', profileId: 'p', apiKey: 'x' }),
      { type: 'state/reset' },
    );
    expect(state.profiles).toHaveLength(0);
    expect(state.sessionKeys).toEqual({});
  });
});
