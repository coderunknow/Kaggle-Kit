import { describe, expect, it } from 'vitest';

import { PROMPT_STARTERS } from './promptStarters';

describe('prompt starters', () => {
  it('offers a small set of distinct starters', () => {
    expect(PROMPT_STARTERS.length).toBeGreaterThanOrEqual(3);
    expect(PROMPT_STARTERS.length).toBeLessThanOrEqual(6);
    expect(new Set(PROMPT_STARTERS.map((starter) => starter.id)).size).toBe(
      PROMPT_STARTERS.length,
    );
  });

  it('has a title, a description and a usable prompt for every starter', () => {
    for (const starter of PROMPT_STARTERS) {
      expect(starter.title.trim().length).toBeGreaterThan(3);
      expect(starter.description.trim().length).toBeGreaterThan(3);
      expect(starter.prompt.trim().length).toBeGreaterThan(20);
    }
  });

  it('does not fill in an answer or claim a capability', () => {
    for (const starter of PROMPT_STARTERS) {
      // The starters describe a task; they must not describe the result.
      expect(starter.prompt.toLowerCase()).not.toContain('as an ai');
      expect(starter.prompt.toLowerCase()).not.toContain('i will now');
    }
  });
});
