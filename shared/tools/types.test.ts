import { describe, expect, it } from 'vitest';

import {
  clampToolLimits,
  DEFAULT_TOOL_PROFILE_SETTINGS,
  effectiveToolSelection,
  mergeConversationLimits,
  shouldPersistToolHistory,
} from './types';

describe('tool settings and bounded budgets', () => {
  it('starts disabled with conservative limits and transient history', () => {
    expect(DEFAULT_TOOL_PROFILE_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_TOOL_PROFILE_SETTINGS.allowedTools).toEqual([]);
    expect(DEFAULT_TOOL_PROFILE_SETTINGS.historyPersistence).toBe(false);
    expect(shouldPersistToolHistory(DEFAULT_TOOL_PROFILE_SETTINGS)).toBe(false);
  });

  it('clamps non-finite and out-of-range limits to hard bounds', () => {
    const limits = clampToolLimits({ maxCalls: 10_000, loopTimeoutMs: Number.POSITIVE_INFINITY, maxOutputBytes: 0 });
    expect(limits.maxCalls).toBe(24);
    expect(limits.loopTimeoutMs).toBe(120_000);
    expect(limits.maxOutputBytes).toBe(1);
  });

  it('lets conversation settings tighten but never loosen profile limits', () => {
    const profile = clampToolLimits({ maxRounds: 3, maxCalls: 6, loopTimeoutMs: 20_000 });
    const limits = mergeConversationLimits(profile, { maxRounds: 20, maxCalls: 2, loopTimeoutMs: 5_000 });
    expect(limits.maxRounds).toBe(3);
    expect(limits.maxCalls).toBe(2);
    expect(limits.loopTimeoutMs).toBe(5_000);
    expect(limits.maxInputBytes).toBe(profile.maxInputBytes);
  });

  it('intersects conversation selections with the profile allowlist', () => {
    const profile = { ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS), enabled: true, allowedTools: ['calculator_calculate', 'web_open'] };
    expect(effectiveToolSelection(profile, { toolIds: ['web_open', 'untrusted_extra'] })).toEqual(['web_open']);
    expect(effectiveToolSelection(profile, { enabled: false })).toEqual([]);
    expect(effectiveToolSelection({ ...profile, enabled: false })).toEqual([]);
    expect(effectiveToolSelection(profile, { toolIds: [] })).toEqual([]);
  });

  it('requires explicit storage-rights confirmation for Brave result history', () => {
    const brave = {
      ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
      historyPersistence: true,
      web: { provider: 'brave' as const },
    };
    expect(shouldPersistToolHistory(brave)).toBe(false);
    expect(shouldPersistToolHistory(brave, { historyPersistence: true })).toBe(false);
    expect(shouldPersistToolHistory({ ...brave, web: { provider: 'brave', storageRightsConfirmed: true } })).toBe(true);
  });
});
