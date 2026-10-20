// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApiProfile, Conversation } from '../../shared/domain';
import { DEFAULT_TOOL_PROFILE_SETTINGS } from '../../shared/tools/types';
import {
  STORAGE_KEYS,
  clearAllStoredData,
  loadBrowserKeys,
  loadConversations,
  loadDrafts,
  loadPreferences,
  loadProfiles,
  removeDraft,
  saveBrowserKeys,
  saveConversations,
  saveDrafts,
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

  it('round trips drafts and drops empty ones', () => {
    saveDrafts({ 'conv-1': 'half a sentence', 'conv-2': '   ', 'conv-3': 'second draft' });

    expect(loadDrafts()).toEqual({ 'conv-1': 'half a sentence', 'conv-3': 'second draft' });

    removeDraft('conv-1');
    expect(loadDrafts()['conv-1']).toBeUndefined();
    expect(loadDrafts()['conv-3']).toBe('second draft');
  });

  it('caps the number and the size of stored drafts', () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 80; index += 1) many[`conv-${index}`] = 'text';
    saveDrafts(many);
    expect(Object.keys(loadDrafts())).toHaveLength(50);

    saveDrafts({ long: 'x'.repeat(30_000) });
    expect(loadDrafts().long).toHaveLength(20_000);
  });

  it('ignores malformed drafts instead of throwing', () => {
    window.localStorage.setItem(STORAGE_KEYS.drafts, '[1, 2, 3]');
    expect(loadDrafts()).toEqual({});

    window.localStorage.setItem(STORAGE_KEYS.drafts, '{"conv-1": 12, "conv-2": "ok"}');
    expect(loadDrafts()).toEqual({ 'conv-2': 'ok' });
  });

  it('clears drafts together with the other local data', () => {
    saveDrafts({ 'conv-1': 'draft text' });
    clearAllStoredData();
    expect(loadDrafts()).toEqual({});
  });

  it('does not persist tool traces by default', () => {
    const withTrace: Conversation = {
      ...conversation,
      messages: [{
        id: 'assistant-1', role: 'assistant', content: 'answer', status: 'complete', createdAt: '2026-01-01T00:00:00.000Z',
        toolJobId: 'runtime-job',
        toolTrace: [{
          id: 'trace-1', toolName: 'calculator_calculate', status: 'succeeded', approvalRequired: false,
          safeArguments: { expression: '1+1' }, requestedAt: '2026-01-01T00:00:00.000Z',
        }],
        sourceCitations: [{ url: 'https://example.com/source' }],
      }],
    };
    saveConversations([withTrace]);
    const serialized = window.localStorage.getItem(STORAGE_KEYS.conversations) ?? '';
    expect(serialized).not.toContain('calculator_calculate');
    expect(serialized).not.toContain('example.com');
    expect(serialized).not.toContain('runtime-job');
  });

  it('does not persist Brave-derived assistant text or citations without retention rights', () => {
    const resultText = 'Search excerpt secret-to-retain';
    const withTransientResult: Conversation = {
      ...conversation,
      toolHistoryPersistence: true,
      messages: [
        { id: 'user-1', role: 'user', content: 'Find current information', status: 'complete', createdAt: '2026-01-01T00:00:00.000Z' },
        {
          id: 'assistant-1', role: 'assistant', content: resultText, reasoning: `Reasoning based on ${resultText}`,
          status: 'complete', createdAt: '2026-01-01T00:00:01.000Z', transientToolContent: true,
          toolTrace: [{ id: 'trace', toolName: 'web_search', status: 'succeeded', approvalRequired: false, safeArguments: { query: 'current info' }, requestedAt: '2026-01-01T00:00:00.000Z' }],
          sourceCitations: [{ url: 'https://example.com/result', title: resultText }],
        },
        { id: 'user-2', role: 'user', content: 'What else?', status: 'complete', createdAt: '2026-01-01T00:00:02.000Z' },
        { id: 'assistant-2', role: 'assistant', content: `Later summary of ${resultText}`, status: 'complete', createdAt: '2026-01-01T00:00:03.000Z' },
      ],
    };

    saveConversations([withTransientResult]);
    const serialized = window.localStorage.getItem(STORAGE_KEYS.conversations) ?? '';
    expect(serialized).not.toContain(resultText);
    expect(serialized).not.toContain('example.com/result');
    expect(serialized).toContain('provider retention rights were not confirmed');
    const restored = loadConversations()[0]?.messages;
    expect(restored?.[1]?.content).toMatch(/not saved because .*provider retention rights/i);
    expect(restored?.[3]?.content).toMatch(/not saved because .*provider retention rights/i);
    expect(restored?.[1]?.transientToolContent).toBeUndefined();
  });

  it('does not restore legacy tool traces or citations when persistence was false or unspecified', () => {
    const message = {
      id: 'assistant-legacy', role: 'assistant', content: 'answer', status: 'complete', createdAt: '2026-01-01T00:00:00.000Z',
      toolTrace: [{ id: 'trace', toolName: 'web_search', status: 'succeeded', approvalRequired: false, safeArguments: { query: 'private query' }, requestedAt: '2026-01-01T00:00:00.000Z' }],
      sourceCitations: [{ url: 'https://example.com/result' }],
    };
    for (const policy of [false, undefined]) {
      window.localStorage.setItem(STORAGE_KEYS.conversations, JSON.stringify([{
        ...conversation,
        ...(policy === undefined ? {} : { toolHistoryPersistence: policy }),
        messages: [message],
      }]));
      const restored = loadConversations()[0]?.messages[0];
      expect(restored?.toolTrace).toBeUndefined();
      expect(restored?.sourceCitations).toBeUndefined();
    }
  });

  it('persists only sanitized tool metadata when explicitly enabled and removes live approval IDs', () => {
    const withTrace: Conversation = {
      ...conversation,
      toolHistoryPersistence: true,
      messages: [{
        id: 'assistant-1', role: 'assistant', content: 'waiting', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z',
        toolJobId: 'runtime-job',
        toolTrace: [{
          id: 'trace-1', toolName: 'code_execute', status: 'awaiting_approval', approvalRequired: true,
          approvalState: 'pending', approvalId: 'short-lived-approval', safeArguments: { code: 'print(1)', apiKey: 'do-not-store' },
          requestedAt: '2026-01-01T00:00:00.000Z',
        }],
        sourceCitations: [{ url: 'javascript:alert(1)' }, { url: 'https://example.com/source', title: 'Source' }],
      }],
    };
    saveConversations([withTrace]);
    const serialized = window.localStorage.getItem(STORAGE_KEYS.conversations) ?? '';
    expect(serialized).not.toContain('runtime-job');
    expect(serialized).not.toContain('short-lived-approval');
    expect(serialized).not.toContain('do-not-store');
    expect(serialized).toContain('[redacted]');
    expect(serialized).not.toContain('javascript:');

    const restored = loadConversations()[0]?.messages[0];
    expect(restored?.toolTrace?.[0]?.status).toBe('interrupted');
    expect(restored?.toolTrace?.[0]?.approvalState).toBe('stale');
    expect(restored?.toolTrace?.[0]?.approvalId).toBeUndefined();
    expect(restored?.sourceCitations).toEqual([{ url: 'https://example.com/source', title: 'Source' }]);
    expect(restored?.toolJobId).toBeUndefined();
  });

  it('strips legacy direct HTTP credentials and unsupported profile fields on load and save', () => {
    const raw = {
      ...profile,
      tools: {
        ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
        httpTools: [{
          id: 'lookup', name: 'Lookup', description: 'Read', endpoint: 'https://api.example.com/data', method: 'GET',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }, permission: 'read_only', timeoutMs: 5000,
          headers: [
            { name: 'Authorization', value: 'legacy-bearer-value' },
            { name: 'X-Tenant', value: 'legacy-tenant-credential' },
            { name: 'Accept', value: 'application/json' },
            { name: 'Authorization', secretRef: 'server-header-key' },
          ],
        }],
        mcpServers: [{
          id: 'remote', name: 'Remote', transport: 'streamable_http', url: 'https://mcp.example.com/mcp', enabled: false, confirmed: false,
          timeoutMs: 5000, tools: [], headers: [{ name: 'X-Token', value: 'legacy-mcp-token' }],
          command: '/legacy/local-server', environment: { API_TOKEN: 'legacy-env-token' },
        }],
        code: { ...DEFAULT_TOOL_PROFILE_SETTINGS.code, apiKey: 'legacy-code-secret' },
      },
    } as unknown as ApiProfile;

    window.localStorage.setItem(STORAGE_KEYS.profiles, JSON.stringify([raw]));
    const loaded = loadProfiles()[0];
    expect(loaded?.tools?.httpTools[0]?.headers).toEqual([
      { name: 'Accept', value: 'application/json' },
      { name: 'Authorization', secretRef: 'server-header-key' },
    ]);
    expect(loaded?.tools?.mcpServers[0]).not.toHaveProperty('command');
    expect(loaded?.tools?.mcpServers[0]).not.toHaveProperty('environment');
    expect(loaded?.tools?.code).not.toHaveProperty('apiKey');
    expect(JSON.stringify(loaded)).not.toContain('legacy-bearer-value');
    expect(JSON.stringify(loaded)).not.toContain('legacy-tenant-credential');
    expect(JSON.stringify(loaded)).not.toContain('legacy-mcp-token');
    expect(JSON.stringify(loaded)).not.toContain('legacy-env-token');
    expect(JSON.stringify(loaded)).not.toContain('legacy-code-secret');

    saveProfiles([raw]);
    const serialized = window.localStorage.getItem(STORAGE_KEYS.profiles) ?? '';
    expect(serialized).not.toContain('legacy-bearer-value');
    expect(serialized).not.toContain('legacy-tenant-credential');
    expect(serialized).not.toContain('legacy-mcp-token');
    expect(serialized).not.toContain('legacy-env-token');
    expect(serialized).not.toContain('legacy-code-secret');
  });

  it('migrates older profiles without tools to the disabled safe defaults', () => {
    window.localStorage.setItem(STORAGE_KEYS.profiles, JSON.stringify([{ ...profile, apiKey: 'legacy-secret' }]));
    const migrated = loadProfiles()[0];
    expect(migrated?.tools?.enabled).toBe(false);
    expect(migrated?.tools?.historyPersistence).toBe(false);
    expect(JSON.stringify(migrated)).not.toContain('legacy-secret');
  });
});
