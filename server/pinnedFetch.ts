/**
 * DNS-pinned fetch for upstream model endpoints.
 *
 * The destination policy in `destinations.ts` validates host *names*. That
 * alone leaves a DNS-rebinding gap: a name could resolve to a public address
 * when checked and to 127.0.0.1 or a cloud-metadata address when connected.
 * This module closes the gap at the actual socket: the HTTP agent's DNS
 * lookup resolves every address, validates the complete answer against the
 * configured policy, and only then hands the connection layer validated
 * addresses to dial. TLS SNI and the Host header keep using the original
 * hostname, so virtual hosting and certificate validation are unchanged.
 *
 * Intentional local endpoints keep working:
 *  - literal IPs and `localhost` are dialed as configured (the hostname
 *    policy already judged them),
 *  - LAN hostnames resolving to private addresses still work in the default
 *    configuration.
 *
 * Refused at connect time, in every configuration:
 *  - link-local / cloud-metadata addresses (never a model endpoint),
 *  - a non-literal, non-localhost hostname resolving to loopback
 *    (the classic rebinding shape; use `127.0.0.1` literally instead),
 *  - any private address when `blockPrivateNetworks` is enabled,
 *  - an empty or failed DNS answer.
 */

import { lookup as dnsLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { FetchLike } from '../shared/api/client';
import {
  isLinkLocalOrMetadata,
  isLoopbackAddress,
  isPrivateAddress,
  normalizeHostname,
  type HostPolicy,
} from './destinations';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultLookupAll: LookupAll = (hostname) => new Promise((resolve, reject) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) reject(error);
    else resolve((addresses ?? []).map((entry) => ({ address: entry.address, family: entry.family })));
  });
});

export class DestinationResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationResolutionError';
  }
}

/**
 * Validate a complete DNS answer for `hostname` against the policy.
 * Returns the addresses that may be dialed; throws on any violation —
 * a single bad address poisons the whole answer so a rebinding record
 * cannot hide behind a good one.
 */
export function assertResolvedAddresses(
  hostname: string,
  addresses: readonly ResolvedAddress[],
  policy: HostPolicy,
): ResolvedAddress[] {
  const normalized = normalizeHostname(hostname);
  if (isIP(normalized)) {
    // The user configured this exact address; destinations.ts judged the
    // private/loopback policy for it. The link-local and cloud-metadata
    // ranges are additionally refused here in every configuration, so no
    // caller of the pinned transport can dial them even when the hostname
    // layer was skipped - the same rule that applies to DNS answers below.
    if (isLinkLocalOrMetadata(normalized)) {
      throw new DestinationResolutionError(
        `The address "${normalized}" is a link-local or cloud-metadata address, which this proxy refuses to reach.`,
      );
    }
    return [{ address: normalized, family: isIP(normalized) }];
  }
  if (addresses.length === 0) {
    throw new DestinationResolutionError(`The host "${normalized}" could not be resolved.`);
  }
  const isLocalName = normalized === 'localhost' || normalized.endsWith('.localhost');
  for (const entry of addresses) {
    if (!isIP(entry.address)) {
      throw new DestinationResolutionError(`The host "${normalized}" resolved to an invalid address.`);
    }
    if (isLinkLocalOrMetadata(entry.address)) {
      throw new DestinationResolutionError(
        `The host "${normalized}" resolves to a link-local or cloud-metadata address, which this proxy refuses to reach.`,
      );
    }
    if (!isLocalName && isLoopbackAddress(entry.address)) {
      throw new DestinationResolutionError(
        `The host "${normalized}" resolves to a loopback address. Refusing a possible DNS-rebinding destination; configure 127.0.0.1 literally for a local server.`,
      );
    }
    if (policy.blockPrivateNetworks && isPrivateAddress(entry.address)) {
      throw new DestinationResolutionError(
        `The host "${normalized}" resolves to a private address, which this proxy refuses to reach.`,
      );
    }
  }
  return [...addresses];
}

/** A `net`-style lookup that validates the full DNS answer before dialing. */
export function createPinnedLookup(policy: HostPolicy, lookupAll: LookupAll = defaultLookupAll): LookupFunction {
  return (hostname, options, callback) => {
    const normalized = normalizeHostname(hostname);
    if (isIP(normalized)) {
      // Literal addresses skip DNS but not the policy: the link-local and
      // cloud-metadata ranges are refused in every configuration, matching
      // assertResolvedAddresses and the module contract above.
      if (isLinkLocalOrMetadata(normalized)) {
        const error = new DestinationResolutionError(
          `The address "${normalized}" is a link-local or cloud-metadata address, which this proxy refuses to reach.`,
        );
        callback(error as NodeJS.ErrnoException, options.all ? [] : '', 0);
        return;
      }
      const family = isIP(normalized);
      if (options.all) callback(null, [{ address: normalized, family }]);
      else callback(null, normalized, family);
      return;
    }
    lookupAll(normalized).then(
      (addresses) => {
        let validated: ResolvedAddress[];
        try {
          validated = assertResolvedAddresses(normalized, addresses, policy);
        } catch (error) {
          callback(error as NodeJS.ErrnoException, options.all ? [] : '', 0);
          return;
        }
        const familyFiltered = options.family
          ? validated.filter((entry) => entry.family === options.family)
          : validated;
        const usable = familyFiltered.length > 0 ? familyFiltered : validated;
        if (options.all) callback(null, usable);
        else callback(null, usable[0]!.address, usable[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, options.all ? [] : '', 0),
    );
  };
}

/**
 * A fetch implementation whose connections are pinned to validated DNS
 * answers. One agent is kept for the lifetime of the returned function.
 */
export function createPinnedFetch(policy: HostPolicy, lookupAll: LookupAll = defaultLookupAll): FetchLike {
  const agent = new Agent({
    connect: { lookup: createPinnedLookup(policy, lookupAll) },
    // Model endpoints are long-lived; keep a small pool and let undici
    // enforce the request-level timeouts the caller sets via signals.
    connections: 8,
  });
  return (async (input: string, init?: RequestInit) => {
    const response = await undiciFetch(input, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    });
    return response as unknown as Response;
  }) as FetchLike;
}
