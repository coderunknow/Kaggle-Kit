import { describe, expect, it } from 'vitest';

import { LIMITS, parseInferenceParams, validateProfileDraft } from './validation';

describe('parseInferenceParams', () => {
  it('falls back to the defaults for an empty payload', () => {
    const { params } = parseInferenceParams(undefined);
    expect(params.maxTokens).toBe(1024);
    expect(params.temperature).toBe(0.7);
    expect(params.topP).toBe(0.95);
    expect(params.stream).toBe(false);
    expect(params.frequencyPenalty).toBeUndefined();
  });

  it('clamps values outside the supported range', () => {
    const { params, issues } = parseInferenceParams({ maxTokens: 999999, temperature: 12, topP: -3 });
    expect(params.maxTokens).toBe(LIMITS.maxTokens.max);
    expect(params.temperature).toBe(LIMITS.temperature.max);
    expect(params.topP).toBe(LIMITS.topP.min);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('ignores an unknown reasoning effort', () => {
    const { params, issues } = parseInferenceParams({ reasoningEffort: 'extreme' });
    expect(params.reasoningEffort).toBeNull();
    expect(issues.join(' ')).toContain('reasoning_effort');
  });

  it('keeps a valid reasoning effort', () => {
    const { params } = parseInferenceParams({ reasoningEffort: 'medium' });
    expect(params.reasoningEffort).toBe('medium');
  });

  it('coerces numeric strings', () => {
    const { params } = parseInferenceParams({ maxTokens: '512', temperature: '0.2' });
    expect(params.maxTokens).toBe(512);
    expect(params.temperature).toBe(0.2);
  });
});

describe('validateProfileDraft', () => {
  const base = {
    name: 'Kaggle',
    baseUrl: 'https://example.com/v1',
    modelId: 'model',
    systemPrompt: '',
    timeoutMs: 120_000,
    credentialStorage: 'session' as const,
  };

  it('accepts a valid draft and normalizes the URL', () => {
    const result = validateProfileDraft({ ...base, baseUrl: 'example.com' });
    expect(result.ok).toBe(true);
    expect(result.normalizedBaseUrl).toBe('https://example.com/v1');
  });

  it('requires a name', () => {
    const result = validateProfileDraft({ ...base, name: '  ' });
    expect(result.ok).toBe(false);
    expect(result.errors.name).toBeTruthy();
  });

  it('reports an invalid base URL', () => {
    const result = validateProfileDraft({ ...base, baseUrl: 'not a url' });
    expect(result.ok).toBe(false);
    expect(result.errors.baseUrl).toBeTruthy();
  });

  it('reports an out-of-range timeout', () => {
    const result = validateProfileDraft({ ...base, timeoutMs: 5 });
    expect(result.ok).toBe(false);
    expect(result.errors.timeoutMs).toBeTruthy();
  });
});
