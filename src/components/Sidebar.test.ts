import { describe, expect, it } from 'vitest';

import type { Conversation } from '../../shared/domain';
import { groupConversations, hostOf } from './Sidebar';

function conversation(id: string, updatedAt: string): Conversation {
  return {
    id,
    title: id,
    profileId: null,
    messages: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

const NOW = new Date('2026-10-19T12:00:00.000Z');

describe('conversation grouping', () => {
  it('sorts the newest conversation first and groups by day', () => {
    const groups = groupConversations(
      [
        conversation('older', '2026-09-01T10:00:00.000Z'),
        conversation('today-a', '2026-10-19T08:00:00.000Z'),
        conversation('yesterday', '2026-10-18T22:00:00.000Z'),
        conversation('week', '2026-10-14T09:00:00.000Z'),
        conversation('today-b', '2026-10-19T11:30:00.000Z'),
      ],
      NOW,
    );

    expect(groups.map((group) => group.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
      'Older',
    ]);
    expect(groups[0]!.conversations.map((entry) => entry.id)).toEqual(['today-b', 'today-a']);
    expect(groups[1]!.conversations.map((entry) => entry.id)).toEqual(['yesterday']);
    expect(groups[2]!.conversations.map((entry) => entry.id)).toEqual(['week']);
    expect(groups[3]!.conversations.map((entry) => entry.id)).toEqual(['older']);
  });

  it('omits empty groups', () => {
    const groups = groupConversations([conversation('today', NOW.toISOString())], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('Today');
  });

  it('survives unparsable timestamps by putting the item last', () => {
    const groups = groupConversations(
      [conversation('broken', 'not-a-date'), conversation('today', NOW.toISOString())],
      NOW,
    );
    expect(groups.at(-1)?.conversations.map((entry) => entry.id)).toEqual(['broken']);
  });
});

describe('connection host formatting', () => {
  it('shows the host and port of a base URL', () => {
    expect(hostOf('https://example.trycloudflare.com/v1')).toBe('example.trycloudflare.com');
    expect(hostOf('http://127.0.0.1:8000/v1')).toBe('127.0.0.1:8000');
  });

  it('falls back to the raw value for an invalid URL', () => {
    expect(hostOf('not a url')).toBe('not a url');
  });
});
