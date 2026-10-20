import { describe, expect, it } from 'vitest';

import { assertPublicUrl, createPinnedLookup, extractHtml, isPublicAddress, retrievePublicPage, validatePublicRedirect, WebToolError, type LookupAll } from './web';

const publicLookup: LookupAll = async () => [{ address: '93.184.216.34', family: 4 }];

describe('public-web destination policy', () => {
  it('returns the pinned address in the callback shape Node requests', () => {
    const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 });
    const results: unknown[][] = [];
    lookup('example.com', { all: true }, (...args) => results.push(args));
    lookup('example.com', { all: false }, (...args) => results.push(args));
    expect(results).toEqual([
      [null, [{ address: '93.184.216.34', family: 4 }]],
      [null, '93.184.216.34', 4],
    ]);
  });

  it('accepts globally routable addresses and blocks special-use ranges', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2001:4860:4860::8888')).toBe(true);
    for (const address of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '198.51.100.2', '::1', 'fc00::1', 'fe80::1', '2001:db8::1',
      '2001:100::1', '2001:20::1', '2002::1', '3ffe::1', '3fff:0::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('extracts bounded page text without exposing scripts or comments and handles malformed markup linearly', () => {
    const extracted = extractHtml('<title>Example &amp; docs</title><!-- hidden --><p>Alpha</p><script>doNotUse()</script><div data-note=">">Beta &lt; Gamma</div>');
    expect(extracted.title).toBe('Example & docs');
    expect(extracted.text).not.toContain('hidden');
    expect(extracted.text).not.toContain('doNotUse');
    expect(extracted.text).toContain('Alpha');
    expect(extracted.text).toContain('Beta < Gamma');

    expect(extractHtml('<script>'.repeat(80_000)).text).toBe('');
  });

  it('removes fragments but refuses credentials, local names, unusual ports and unsafe DNS answers', async () => {
    const safe = await assertPublicUrl('https://example.com/path#fragment', publicLookup);
    expect(safe.hash).toBe('');
    const ipv6 = await assertPublicUrl('https://[2001:4860:4860::8888]/', async () => { throw new Error('IP literals should not use DNS.'); });
    expect(ipv6.hostname).toBe('[2001:4860:4860::8888]');
    await expect(assertPublicUrl('https://[2001:db8::1]/', publicLookup)).rejects.toThrow(/reserved IP/i);
    await expect(assertPublicUrl('https://user:pass@example.com/', publicLookup)).rejects.toThrow(WebToolError);
    await expect(assertPublicUrl('https://example.com/?api_key=private-value', publicLookup)).rejects.toThrow(/credential-like query parameters/i);
    await expect(assertPublicUrl('https://example.com/?X-Amz-Signature=private-value', publicLookup)).rejects.toThrow(/credential-like query parameters/i);
    await expect(assertPublicUrl('https://example.com/?search=ordinary', publicLookup)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://localhost/admin', publicLookup)).rejects.toThrow(/reserved host names/i);
    await expect(assertPublicUrl('https://example.com:8443/', publicLookup)).rejects.toThrow(/standard web ports/i);
    await expect(assertPublicUrl('https://example.com/', async () => [
      { address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 },
    ])).rejects.toThrow(/resolves to a private/i);
  });

  it('revalidates redirects, blocks private targets and refuses HTTPS downgrades', async () => {
    const current = new URL('https://example.com/start');
    await expect(validatePublicRedirect(current, 'http://example.com/unsafe', publicLookup)).rejects.toThrow(/downgrade/i);
    await expect(validatePublicRedirect(current, 'https://127.0.0.1/admin', publicLookup)).rejects.toThrow(/private|loopback/i);
    await expect(validatePublicRedirect(current, 'https://metadata.google.internal/', publicLookup)).rejects.toThrow(/reserved host names/i);
    expect((await validatePublicRedirect(current, '../next', publicLookup)).toString()).toBe('https://example.com/next');
  });

  it('refuses a DNS rebinding answer before opening a socket', async () => {
    let resolutions = 0;
    const rebinding: LookupAll = async () => {
      resolutions += 1;
      return resolutions === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    };
    await expect(retrievePublicPage('https://example.com/', rebinding)).rejects.toThrow(/private/i);
    expect(resolutions).toBe(2);
  });

  it('does not start a socket for a request that is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(retrievePublicPage('https://example.com/', publicLookup, controller.signal)).rejects.toThrow(/cancelled/i);
  });
});
