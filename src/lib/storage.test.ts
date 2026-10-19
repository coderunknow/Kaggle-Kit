// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApiProfile, Conversation } from '../../shared/domain';
import {
  STORAGE_KEYS,
  clearAllStoredData,
  loadBrowserKeys,
  loadConversations,
  loadPreferences,
  loadProfiles,
  saveBrowserKeys,
  saveConversations,
  savePreferences,
  saveProfiles,
} from './storage';

const profile: ApiProfile = {
  id: 'profile-1',
  name: 'Kaggle',
  baseUrl: 'http://127.0.0.1:8000/v1',
  modelId: 'mock-model',
  systemPrompt: 'Be brief.',
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
  messages: [
    { id: 'm1', role: 'user', content: 'hi', status: 'complete', createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('browser storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round trips profiles, conversations and preferences', () => {
    saveProfiles([profile]);
    saveConversations([conversation]);
    savePreferences({ activeProfileId: 'profile-1', activeConversationId: 'conv-1', theme: 'dark', sendOnEnter: true });

    expect(loadProfiles()[0]?.id).toBe('profile-1');
    expect(loadConversations()[0]?.messages).toHaveLength(1);
    expect(loadPreferences().theme).toBe('dark');
  });

  it('never persists a session credential', () => {
    saveProfiles([profile]);
    saveBrowserKeys({});

    const dump = JSON.stringify(window.localStorage);
    expect(dump).not.toContain('apiKey');
    expect(loadBrowserKeys()).toEqual({});
  });

  it('stores browser credentials only when the user opted in', () => {
    saveBrowserKeys({ 'profile-1': 'plain-text-key' });
    expect(loadBrowserKeys()['profile-1']).toBe('plain-text-key');
  });

  it('removes every key the application owns', () => {
    saveProfiles([profile]);
    saveConversations([conversation]);
    savePreferences({ activeProfileId: null, activeConversationId: null, theme: 'system', sendOnEnter: true });
    saveBrowserKeys({ 'profile-1': 'plain-text-key' });

    clearAllStoredData();

    for (const key of Object.values(STORAGE_KEYS)) {
      expect(window.localStorage.getItem(key)).toBeNull();
    }
  });

  it('survives corrupted data without crashing', () => {
    window.localStorage.setItem(STORAGE_KEYS.profiles, '{not json');
    window.localStorage.setItem(STORAGE_KEYS.conversations, '"a string"');

    expect(loadProfiles()).toEqual([]);
    expect(loadConversations()).toEqual([]);
  });
});
