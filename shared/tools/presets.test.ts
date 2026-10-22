import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_PROFILE_SETTINGS } from './types';
import { applyCorePreset, CORE_PRESETS, grantKeylessCore, KEYLESS_CORE_TOOLS } from './presets';
import { buildToolDefinitions } from './catalog';

describe('reviewed keyless grant and narrowing presets', () => {
  it('needs explicit grant and never configures external providers or code', () => {
    const original = structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS);
    const granted = grantKeylessCore(original);
    expect(original).toEqual(DEFAULT_TOOL_PROFILE_SETTINGS);
    expect(granted.enabled).toBe(true);
    expect(buildToolDefinitions(granted).map((tool) => tool.function.name).sort()).toEqual([...KEYLESS_CORE_TOOLS].sort());
    expect(granted.web.provider).toBe('disabled');
    expect(granted.code.provider).toBe('disabled');
    expect(granted.limits).toEqual(original.limits);
    expect(granted.historyPersistence).toBe(false);
  });

  it('all presets only narrow existing authority, including an empty allowlist', () => {
    for (const preset of Object.keys(CORE_PRESETS) as Array<keyof typeof CORE_PRESETS>) {
      const settings = structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS);
      settings.allowedTools = ['files_read', 'http_unreviewed', 'code_execute'];
      const narrowed = applyCorePreset(settings, preset);
      expect(narrowed.allowedTools.every((name) => settings.allowedTools.includes(name))).toBe(true);
      expect(narrowed.allowedTools).not.toContain('code_execute');
      expect(narrowed.allowedTools).not.toContain('http_unreviewed');
      expect(applyCorePreset(DEFAULT_TOOL_PROFILE_SETTINGS, preset).allowedTools).toEqual([]);
    }
  });

  it('chat only disables without deleting advanced configuration', () => {
    const settings = grantKeylessCore(structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS));
    const narrowed = applyCorePreset(settings, 'chat');
    expect(narrowed.enabled).toBe(false);
    expect(narrowed.httpTools).toEqual(settings.httpTools);
    expect(narrowed.code).toEqual(settings.code);
  });
});
