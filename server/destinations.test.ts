import { describe, expect, it } from 'vitest';

import {
  assertDestinationAllowed,
  hostnameMatches,
  isPrivateAddress,
  normalizeHostname,
} from './destinations';

describe('host name normalization', () => {
  it('lower cases the host and removes the trailing dot of a FQDN', () => {
    expect(normalizeHostname('Example.COM.')).toBe('example.com');
    expect(normalizeHostname('  API.Example.com ')).toBe('api.example.com');
  });

  it('removes the brackets of an IPv6 literal', () => {
    expect(normalizeHostname('[::1]')).toBe('::1');
  });
});

describe('allow list matching', () => {
  it('matches an exact host name', () => {
    expect(hostnameMatches('example.com', 'example.com')).toBe(true);
    expect(hostnameMatches('example.com', 'other.com')).toBe(false);
  });

  it('is case insensitive and ignores the trailing dot', () => {
    expect(hostnameMatches('Example.com', 'example.com.')).toBe(true);
  });

  it('matches sub domains of a wildcard pattern', () => {
    expect(hostnameMatches('*.example.com', 'api.example.com')).toBe(true);
    expect(hostnameMatches('*.example.com', 'example.com')).toBe(false);
    expect(hostnameMatches('*.example.com', 'a.b.example.com')).toBe(true);
  });

  it('does not let a wildcard match a different domain', () => {
    expect(hostnameMatches('*.example.com', 'example.com.evil.test')).toBe(false);
    expect(hostnameMatches('*.example.com', 'notexample.com')).toBe(false);
  });
});

describe('private address detection', () => {
  it('detects loopback, private and link local addresses', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('127.5.5.5')).toBe(true);
    expect(isPrivateAddress('10.0.0.5')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.31.255.254')).toBe(true);
    expect(isPrivateAddress('192.168.1.10')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('localhost')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
  });

  it('does not flag public addresses', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('example.com')).toBe(false);
  });
});

describe('destination policy', () => {
  it('allows every host when no allow list is configured', () => {
    expect(() =>
      assertDestinationAllowed('https://api.example.com/v1', {
        allowedHosts: null,
        blockPrivateNetworks: false,
      }),
    ).not.toThrow();
  });

  it('refuses a host that is not on the allow list', () => {
    expect(() =>
      assertDestinationAllowed('https://api.evil.test/v1', {
        allowedHosts: ['api.example.com'],
        blockPrivateNetworks: false,
      }),
    ).toThrowError(/not in the allow list/);
  });

  it('allows a host on the allow list even when it is private', () => {
    expect(() =>
      assertDestinationAllowed('http://127.0.0.1:8080/v1', {
        allowedHosts: ['127.0.0.1'],
        blockPrivateNetworks: true,
      }),
    ).not.toThrow();
  });

  it('refuses a private address when private networks are blocked', () => {
    expect(() =>
      assertDestinationAllowed('http://127.0.0.1:8080/v1', {
        allowedHosts: null,
        blockPrivateNetworks: true,
      }),
    ).toThrowError(/private or loopback/);
  });

  it('refuses a public address when private networks are blocked', () => {
    expect(() =>
      assertDestinationAllowed('https://api.example.com/v1', {
        allowedHosts: null,
        blockPrivateNetworks: true,
      }),
    ).not.toThrow();
  });

  it('rejects a URL that cannot be parsed', () => {
    expect(() =>
      assertDestinationAllowed('not a url', { allowedHosts: null, blockPrivateNetworks: false }),
    ).toThrowError(/not a valid URL/);
  });
});
