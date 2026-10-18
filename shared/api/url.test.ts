import { describe, expect, it } from 'vitest';

import { UrlValidationError, isQuickTunnelUrl, joinApiPath, normalizeBaseUrl, normalizeBaseUrlDetailed } from './url';

describe('normalizeBaseUrl', () => {
  it('adds the /v1 prefix to a bare host', () => {
    expect(normalizeBaseUrl('https://example.com')).toBe('https://example.com/v1');
  });

  it('does not duplicate an existing /v1 suffix', () => {
    expect(normalizeBaseUrl('https://example.com/v1')).toBe('https://example.com/v1');
  });

  it('removes trailing slashes', () => {
    expect(normalizeBaseUrl('https://example.com/v1///')).toBe('https://example.com/v1');
  });

  it('keeps a path prefix and appends /v1', () => {
    expect(normalizeBaseUrl('https://example.com/openai')).toBe('https://example.com/openai/v1');
  });

  it('reduces a pasted chat completions endpoint to its base', () => {
    expect(normalizeBaseUrl('https://example.com/v1/chat/completions')).toBe('https://example.com/v1');
  });

  it('upgrades a missing scheme to https', () => {
    expect(normalizeBaseUrl('example.com/v1')).toBe('https://example.com/v1');
  });

  it('keeps an explicit http scheme for local servers', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/v1');
  });

  it('rejects an empty value', () => {
    expect(() => normalizeBaseUrl('   ')).toThrow(UrlValidationError);
  });

  it('rejects a non http(s) scheme', () => {
    expect(() => normalizeBaseUrl('ftp://example.com')).toThrow(UrlValidationError);
  });

  it('rejects embedded credentials', () => {
    expect(() => normalizeBaseUrl('https://user:pass@example.com')).toThrow(UrlValidationError);
  });

  it('rejects a query string', () => {
    expect(() => normalizeBaseUrl('https://example.com/v1?token=abc')).toThrow(UrlValidationError);
  });

  it('rejects whitespace inside the value', () => {
    expect(() => normalizeBaseUrl('https://example .com/v1')).toThrow(UrlValidationError);
  });

  it('reports what it changed', () => {
    const result = normalizeBaseUrlDetailed('example.com');
    expect(result.changed).toBe(true);
    expect(result.baseUrl).toBe('https://example.com/v1');
    expect(result.notes.join(' ')).toContain('/v1');
  });
});

describe('joinApiPath', () => {
  it('joins without duplicating slashes', () => {
    expect(joinApiPath('https://example.com/v1', '/models')).toBe('https://example.com/v1/models');
    expect(joinApiPath('https://example.com/v1/', 'models')).toBe('https://example.com/v1/models');
  });
});

describe('isQuickTunnelUrl', () => {
  it('detects Cloudflare Quick Tunnel hosts', () => {
    expect(isQuickTunnelUrl('https://random-words.trycloudflare.com/v1')).toBe(true);
  });

  it('returns false for other hosts', () => {
    expect(isQuickTunnelUrl('https://example.com/v1')).toBe(false);
  });
});
