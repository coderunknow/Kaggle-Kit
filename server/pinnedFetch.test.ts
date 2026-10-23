import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostPolicy } from './destinations';
import {
  assertResolvedAddresses,
  createPinnedFetch,
  createPinnedLookup,
  DestinationResolutionError,
  type LookupAll,
} from './pinnedFetch';

const OPEN_POLICY: HostPolicy = { allowedHosts: null, blockPrivateNetworks: false };
const STRICT_POLICY: HostPolicy = { allowedHosts: null, blockPrivateNetworks: true };

function fakeLookup(addresses: Array<{ address: string; family: number }>): LookupAll {
  return async () => addresses;
}

describe('assertResolvedAddresses', () => {
  it('passes benign literal IPs through (already judged by the hostname policy)', () => {
    expect(assertResolvedAddresses('127.0.0.1', [], OPEN_POLICY)).toEqual([{ address: '127.0.0.1', family: 4 }]);
    expect(assertResolvedAddresses('[::1]', [], OPEN_POLICY)).toEqual([{ address: '::1', family: 6 }]);
    expect(assertResolvedAddresses('192.168.1.50', [], OPEN_POLICY)).toEqual([{ address: '192.168.1.50', family: 4 }]);
  });

  it('refuses literal link-local and cloud-metadata addresses in every configuration', () => {
    for (const address of ['169.254.169.254', '169.254.1.2', '100.100.100.200', '[fe80::1]', 'fd00:ec2::254', '[::ffff:169.254.169.254]', '::ffff:a9fe:a9fe']) {
      for (const policy of [OPEN_POLICY, STRICT_POLICY]) {
        expect(() => assertResolvedAddresses(address, [], policy), `${address} ${JSON.stringify(policy)}`)
          .toThrow(/link-local or cloud-metadata/);
      }
    }
  });

  it('allows localhost names to resolve to loopback', () => {
    const result = assertResolvedAddresses('localhost', [{ address: '127.0.0.1', family: 4 }], OPEN_POLICY);
    expect(result).toHaveLength(1);
  });

  it('refuses a public hostname that rebinds to loopback', () => {
    expect(() => assertResolvedAddresses('tunnel.example.com', [{ address: '127.0.0.1', family: 4 }], OPEN_POLICY))
      .toThrow(DestinationResolutionError);
    expect(() => assertResolvedAddresses('tunnel.example.com', [{ address: '::1', family: 6 }], OPEN_POLICY))
      .toThrow(/loopback/);
    expect(() => assertResolvedAddresses('tunnel.example.com', [{ address: '::ffff:127.0.0.1', family: 6 }], OPEN_POLICY))
      .toThrow(/loopback/);
  });

  it('refuses metadata and link-local answers in every configuration', () => {
    for (const address of ['169.254.169.254', '169.254.1.2', '100.100.100.200', 'fe80::1', 'fd00:ec2::254']) {
      expect(
        () => assertResolvedAddresses('api.example.com', [{ address, family: address.includes(':') ? 6 : 4 }], OPEN_POLICY),
        address,
      ).toThrow(/link-local or cloud-metadata/);
    }
  });

  it('refuses the whole answer when one record is hostile', () => {
    expect(() => assertResolvedAddresses('api.example.com', [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ], OPEN_POLICY)).toThrow(DestinationResolutionError);
  });

  it('keeps LAN hostnames working by default but not under the strict policy', () => {
    const lan = [{ address: '192.168.1.50', family: 4 }];
    expect(assertResolvedAddresses('llama.home', lan, OPEN_POLICY)).toHaveLength(1);
    expect(() => assertResolvedAddresses('llama.home', lan, STRICT_POLICY)).toThrow(/private/);
    expect(() => assertResolvedAddresses('api.example.com', [{ address: '10.0.0.5', family: 4 }], STRICT_POLICY)).toThrow(/private/);
  });

  it('refuses empty and invalid DNS answers', () => {
    expect(() => assertResolvedAddresses('gone.example.com', [], OPEN_POLICY)).toThrow(/could not be resolved/);
    expect(() => assertResolvedAddresses('bad.example.com', [{ address: 'not-an-ip', family: 4 }], OPEN_POLICY)).toThrow(/invalid address/);
  });
});

describe('createPinnedFetch against a real socket', () => {
  let server: http.Server | undefined;
  let port = 0;

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  async function startServer(): Promise<void> {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  }

  it('dials a literal loopback endpoint', async () => {
    await startServer();
    const fetchPinned = createPinnedFetch(OPEN_POLICY, fakeLookup([]));
    const response = await fetchPinned(`http://127.0.0.1:${port}/v1/models`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"ok":true');
  });

  it('refuses a hostname whose injected DNS answer rebinds to loopback', async () => {
    await startServer();
    const fetchPinned = createPinnedFetch(OPEN_POLICY, fakeLookup([{ address: '127.0.0.1', family: 4 }]));
    await expect(fetchPinned(`http://rebinding.example.com:${port}/v1/models`)).rejects.toThrow();
  });

  it('refuses a hostname whose injected DNS answer is the metadata address', async () => {
    await startServer();
    const fetchPinned = createPinnedFetch(OPEN_POLICY, fakeLookup([{ address: '169.254.169.254', family: 4 }]));
    await expect(fetchPinned(`http://metadata.example.com:${port}/latest`)).rejects.toThrow();
  });

});

describe('createPinnedLookup', () => {
  it('refuses a literal metadata address through the lookup callback', async () => {
    // Defense in depth: undici skips the DNS lookup for IP literals, so the
    // production refusal happens in destinations.assertDestinationAllowed
    // before any fetch (covered in proxy.test.ts). The pinned lookup itself
    // must still refuse the literal when it is asked to resolve one, so no
    // transport consumer can ever dial the metadata ranges.
    const lookup = createPinnedLookup(OPEN_POLICY, fakeLookup([]));
    const error = await new Promise<unknown>((resolve) => {
      lookup('169.254.169.254', { all: true } as never, (err: unknown) => resolve(err));
    });
    expect(error).toBeInstanceOf(DestinationResolutionError);
    expect((error as Error).message).toMatch(/link-local or cloud-metadata/);
  });

  it('resolves a benign literal without consulting DNS', async () => {
    const lookup = createPinnedLookup(OPEN_POLICY, fakeLookup([]));
    const result = await new Promise<unknown>((resolve) => {
      lookup('127.0.0.1', { all: true } as never, (err: unknown, addresses: unknown) => resolve(err ?? addresses));
    });
    expect(result).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });
});
