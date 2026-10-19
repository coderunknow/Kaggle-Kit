import { describe, expect, it } from 'vitest';

import type { ApiProfile, Conversation } from '../../shared/domain';
import { conversationToMarkdown, exportFileName } from './export';

const profile: ApiProfile = {
  id: 'profile-1',
  name: 'Kaggle T4',
  baseUrl: 'https://example.trycloudflare.com/v1',
  modelId: 'qwen3-8b',
  systemPrompt: '',
  timeoutMs: 120_000,
  credentialStorage: 'session',
  defaultParams: { maxTokens: 1024, temperature: 0.7, topP: 0.95, stream: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const conversation: Conversation = {
  id: 'conv-1',
  title: 'Hash tables',
  profileId: 'profile-1',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:05:00.000Z',
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: 'Show me a hash table',
      status: 'complete',
      createdAt: '2026-01-01T10:00:00.000Z',
    },
    {
      id: 'm2',
      role: 'assistant',
      content: 'A hash table maps keys to values.\n\n```python\nhash("key")\n```',
      status: 'complete',
      createdAt: '2026-01-01T10:01:00.000Z',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
    {
      id: 'm3',
      role: 'assistant',
      content: 'partial answer',
      status: 'cancelled',
      createdAt: '2026-01-01T10:02:00.000Z',
    },
    {
      id: 'm4',
      role: 'assistant',
      content: '',
      status: 'error',
      errorMessage: 'The server is not reachable.',
      createdAt: '2026-01-01T10:03:00.000Z',
    },
  ],
};

describe('conversation export', () => {
  it('writes the title, both roles and the Markdown of the answer', () => {
    const markdown = conversationToMarkdown(conversation, profile);

    expect(markdown).toContain('# Hash tables');
    expect(markdown).toContain('## You');
    expect(markdown).toContain('## Assistant');
    expect(markdown).toContain('Show me a hash table');
    expect(markdown).toContain('```python');
    expect(markdown).toContain('hash("key")');
    expect(markdown).toContain('- Connection: Kaggle T4 (https://example.trycloudflare.com/v1)');
    expect(markdown).toContain('- Model: qwen3-8b');
  });

  it('marks cancelled and failed answers instead of presenting them as complete', () => {
    const markdown = conversationToMarkdown(conversation, profile);

    expect(markdown).toContain('_The request was cancelled.');
    expect(markdown).toContain('_The request failed. The server is not reachable._');
    expect(markdown).toContain('_(no text)_');
  });

  it('only reports token usage that the server actually returned', () => {
    const markdown = conversationToMarkdown(conversation, profile);
    expect(markdown).toContain('_Tokens reported by the server: 30_');

    const withoutUsage = conversationToMarkdown(
      { ...conversation, messages: conversation.messages.slice(0, 1) },
      profile,
    );
    expect(withoutUsage).not.toContain('Tokens reported by the server');
  });

  it('does not include credentials or request parameters', () => {
    const markdown = conversationToMarkdown(conversation, profile);
    expect(markdown).not.toMatch(/api[-_]?key/i);
    expect(markdown).not.toMatch(/secret/i);
    expect(markdown).not.toContain('maxTokens');
  });

  it('derives a safe file name from the conversation title', () => {
    expect(exportFileName('Hash tables: a primer')).toBe('hash-tables-a-primer.md');
    expect(exportFileName('../../etc/passwd')).toBe('etc-passwd.md');
    expect(exportFileName('???')).toBe('conversation.md');
    expect(exportFileName('x'.repeat(200))).toHaveLength(63);
  });
});
