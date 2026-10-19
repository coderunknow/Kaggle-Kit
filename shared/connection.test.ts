import { describe, expect, it } from 'vitest';

import {
  effectiveProfileTarget,
  profileConfigFingerprint,
  profileFingerprint,
  resolveConnectionView,
} from './connection';
import type { ServerCapabilities } from './api/requests';
import type { ApiProfile, ConnectionTestResult } from './domain';

const profile: ApiProfile = {
  id: 'p1',
  name: 'Kaggle',
  baseUrl: 'https://example.trycloudflare.com',
  modelId: 'qwen',
  systemPrompt: '',
  timeoutMs: 120_000,
  credentialStorage: 'session',
  defaultParams: { maxTokens: 1024, temperature: 0.7, topP: 0.95, stream: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const capabilities: ServerCapabilities = {
  streamingVerified: true,
  reasoningEffortSupported: false,
  notes: [],
};

function result(overrides: Partial<ConnectionTestResult> = {}): ConnectionTestResult {
  return {
    ok: true,
    baseUrl: 'https://example.trycloudflare.com/v1',
    stages: [],
    modelId: 'qwen',
    capabilities,
    testedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function state(connectionTests: Record<string, ConnectionTestResult | undefined> = {}, keys = { p1: 'key' }) {
  return { connectionTests, sessionKeys: keys, browserKeys: {} as Record<string, string> };
}

describe('effectiveProfileTarget', () => {
  it('normalizes a bare tunnel URL to a single /v1 suffix', () => {
    const target = effectiveProfileTarget(profile);
    expect(target.requestedBaseUrl).toBe('https://example.trycloudflare.com');
    expect(target.baseUrl).toBe('https://example.trycloudflare.com/v1');
    expect(target.changed).toBe(true);
  });

  it('does not duplicate an existing /v1 suffix, with or without a trailing slash', () => {
    for (const baseUrl of [
      'https://example.trycloudflare.com/v1',
      'https://example.trycloudflare.com/v1/',
    ]) {
      const target = effectiveProfileTarget({ ...profile, baseUrl });
      expect(target.baseUrl).toBe('https://example.trycloudflare.com/v1');
      expect(target.baseUrl.match(/\/v1/g)).toHaveLength(1);
    }
  });

  it('keeps a legitimate path and appends the API suffix', () => {
    const target = effectiveProfileTarget({ ...profile, baseUrl: 'https://host.example/openai' });
    expect(target.baseUrl).toBe('https://host.example/openai/v1');
  });

  it('returns the typed value and an error instead of silently changing an invalid URL', () => {
    const target = effectiveProfileTarget({ ...profile, baseUrl: 'ftp://host.example' });
    expect(target.baseUrl).toBe('ftp://host.example');
    expect(target.error).toBeTruthy();
  });
});

describe('connection fingerprints', () => {
  it('ignores the key, the name and the system prompt in the configuration fingerprint', () => {
    const withKey = profileFingerprint(profile, { apiKey: 'a' });
    const withOtherKey = profileFingerprint({ ...profile, name: 'Other', systemPrompt: 'x' }, {
      apiKey: 'b',
    });
    expect(withKey).toBe(withOtherKey);
    expect(profileConfigFingerprint(profile)).toBe(
      profileConfigFingerprint({ ...profile, name: 'Renamed', systemPrompt: 'Be brief.' }),
    );
  });

  it('changes when the model, the timeout, the URL or the credential mode changes', () => {
    const base = profileConfigFingerprint(profile);
    expect(profileConfigFingerprint({ ...profile, modelId: 'other' })).not.toBe(base);
    expect(profileConfigFingerprint({ ...profile, timeoutMs: 1 })).not.toBe(base);
    expect(profileConfigFingerprint({ ...profile, baseUrl: 'https://other.example' })).not.toBe(base);
    expect(profileConfigFingerprint({ ...profile, credentialStorage: 'browser' })).not.toBe(base);
  });

  it('distinguishes a missing key from a present one', () => {
    expect(profileFingerprint(profile, {})).not.toBe(profileFingerprint(profile, { apiKey: 'x' }));
  });
});

describe('resolveConnectionView', () => {
  it('reports a missing profile', () => {
    const view = resolveConnectionView(state(), undefined);
    expect(view.state).toBe('missing');
    expect(view.tone).toBe('neutral');
  });

  it('reports an untested profile', () => {
    const view = resolveConnectionView(state(), profile);
    expect(view.state).toBe('untested');
  });

  it('reports a result whose fingerprint belongs to the current configuration', () => {
    const fingerprint = profileFingerprint(profile, { apiKey: 'key' });
    const view = resolveConnectionView(state({ p1: result({ configFingerprint: fingerprint }) }), profile);
    expect(view.state).toBe('connected');
    expect(view.test).toBeDefined();
  });

  it('reports a failed result as failed and never as connected', () => {
    const fingerprint = profileFingerprint(profile, { apiKey: 'key' });
    const view = resolveConnectionView(
      state({ p1: result({ ok: false, configFingerprint: fingerprint }) }),
      profile,
    );
    expect(view.state).toBe('failed');
    expect(view.tone).toBe('danger');
  });

  it('marks a result stale when the configuration or the credential changed', () => {
    const fingerprint = profileFingerprint(profile, { apiKey: 'key' });
    const stored = state({ p1: result({ configFingerprint: fingerprint }) });

    expect(
      resolveConnectionView(stored, { ...profile, baseUrl: 'https://other.example' }).state,
    ).toBe('stale');
    expect(resolveConnectionView(stored, profile).state).toBe('connected');
    // A key that disappears (reload, cleared session) makes the test stale.
    // Replacing a key with another one is handled by the reducer, which drops
    // the stored result when the key is written.
    expect(
      resolveConnectionView({ ...stored, sessionKeys: {} }, profile).state,
    ).toBe('stale');
  });

  it('does not trust a result that predates fingerprints', () => {
    const view = resolveConnectionView(state({ p1: result() }), profile);
    expect(view.state).toBe('untested');
  });
});
