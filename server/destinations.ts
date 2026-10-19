/**
 * Destination policy for the upstream proxy.
 *
 * The proxy is meant to reach arbitrary OpenAI-compatible endpoints, so a
 * blanket restriction would break the product. The policy is therefore
 * explicit and configurable:
 *
 *  - `KAGGLE_KIT_ALLOWED_HOSTS` – an allow list of host names. When it is set,
 *    only those hosts (and their sub domains when written as `*.example.com`)
 *    may be reached.
 *  - `KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS=1` – additionally refuse loopback,
 *    private, link local and unique local addresses. This is **off** by
 *    default because the primary use case is a `llama-server` on
 *    `127.0.0.1` or a private LAN address.
 *
 * The checks work on the host name of the URL. A host name that resolves to a
 * private address (DNS rebinding) is not detected here – that is why the
 * allow list is the recommended control for a proxy that is reachable from
 * another machine.
 */

import { ApiError } from '../shared/api/errors';

export interface HostPolicy {
  /** Allowed host names. `null` means "no allow list". */
  allowedHosts: string[] | null;
  /** Refuse loopback, private and link local destinations. */
  blockPrivateNetworks: boolean;
}

/** Lower case a host name and remove the trailing dot of a FQDN. */
export function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  while (host.endsWith('.')) {
    host = host.slice(0, -1);
  }
  return host;
}

/** True when the host matches the pattern (exact match or `*.suffix`). */
export function hostnameMatches(pattern: string, host: string): boolean {
  const normalizedPattern = normalizeHostname(pattern);
  const normalizedHost = normalizeHostname(host);

  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(1); // ".example.com"
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
  }

  return normalizedHost === normalizedPattern;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True when the host is an address in a range that is not reachable publicly. */
export function isPrivateAddress(host: string): boolean {
  const normalized = normalizeHostname(host);

  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  const ipv4 = IPV4_PATTERN.exec(normalized);
  if (ipv4) {
    const octets = ipv4.slice(1, 5).map((value) => Number.parseInt(value, 10));
    if (octets.some((value) => Number.isNaN(value) || value > 255)) return false;
    const [a, b] = octets as [number, number, number, number];
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link local, includes the cloud metadata address
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier grade NAT
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    return false;
  }

  // IPv6 unique local (fc00::/7) and link local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;

  return false;
}

/**
 * Check a destination against the policy.
 *
 * @throws {ApiError} when the destination is not allowed.
 */
export function assertDestinationAllowed(baseUrl: string, policy: HostPolicy): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new ApiError('bad_request', 'The base URL is not a valid URL.', {
      hint: 'Fix the base URL of the profile.',
    });
  }

  const normalized = normalizeHostname(host);
  const allowed = policy.allowedHosts;

  if (allowed && allowed.length > 0) {
    if (!allowed.some((pattern) => hostnameMatches(pattern, normalized))) {
      throw new ApiError(
        'bad_request',
        `The host "${normalized}" is not in the allow list of this proxy.`,
        { hint: 'Add the host to KAGGLE_KIT_ALLOWED_HOSTS or use a different endpoint.' },
      );
    }
    return;
  }

  if (policy.blockPrivateNetworks && isPrivateAddress(normalized)) {
    throw new ApiError(
      'bad_request',
      `The host "${normalized}" is a private or loopback address, which this proxy refuses to reach.`,
      {
        hint:
          'Unset KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS to allow local inference servers, or add the host to KAGGLE_KIT_ALLOWED_HOSTS.',
      },
    );
  }
}
