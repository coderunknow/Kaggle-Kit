import type { ToolProfileSettings } from './types';

/** Only these reviewed, read-only handlers are offered by the keyless grant. */
export const KEYLESS_CORE_TOOLS = [
  'calculator_calculate', 'calculator_convert', 'files_list', 'files_read',
  'files_analyze', 'diagnostics_check', 'web_open',
] as const;

export const CORE_PRESETS = {
  chat: { label: 'Chat only', tools: [] },
  everyday: { label: 'Everyday tools', tools: [...KEYLESS_CORE_TOOLS] },
  documents: { label: 'Document analysis', tools: ['files_list', 'files_read', 'files_analyze'] },
  web: { label: 'Web research (page retrieval only)', tools: ['web_open'] },
} as const;

/** Presets narrow an existing grant; they never grant new authority. */
export function applyCorePreset(settings: ToolProfileSettings, preset: keyof typeof CORE_PRESETS): ToolProfileSettings {
  const selected: readonly string[] = CORE_PRESETS[preset].tools;
  return {
    ...settings,
    enabled: preset !== 'chat',
    allowedTools: settings.allowedTools.filter((name) => selected.includes(name)),
  };
}

/** An explicit profile-level grant, distinct from a narrowing preset. Save is still required. */
export function grantKeylessCore(settings: ToolProfileSettings): ToolProfileSettings {
  return {
    ...settings,
    enabled: true,
    allowedTools: [...new Set([...settings.allowedTools, ...KEYLESS_CORE_TOOLS])],
  };
}
