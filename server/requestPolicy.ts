/**
 * Request policy helpers for the local proxy backend.
 *
 * The backend is reachable from the browser, so it has to make sure that a
 * request really comes from the local application and not from another page
 * in the browser (cross site request forgery) or from a page that resolved to
 * the loopback address (DNS rebinding).
 *
 * The controls are deliberately small:
 *
 *  - a request with an `Origin` header must come from an allowed origin; the
 *    origin of the request itself is only trusted when the `Host` is a
 *    loopback address — otherwise a DNS-rebinding domain (attacker DNS name
 *    resolving to 127.0.0.1, so `Host` and `Origin` both carry the attacker
 *    name) would trivially satisfy a self-origin check. Non-loopback
 *    serving must list its origin in `KAGGLE_KIT_ALLOWED_ORIGINS`,
 *  - a request with a body must use `Content-Type: application/json`, which a
 *    browser cannot send cross origin without a preflight,
 *  - static files are resolved inside the client directory with a proper
 *    containment check.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import { isLoopbackAddress } from './destinations';
import { HttpError } from './http';

export interface OriginPolicy {
  /** Extra origins that may call the API. */
  allowedOrigins: string[] | null;
}

/**
 * True when the request may be answered.
 *
 * A request without an `Origin` header does not come from a browser page
 * (command line clients, the test suite) and is accepted.
 */
export function isAllowedOrigin(
  request: IncomingMessage,
  policy: OriginPolicy,
): { allowed: boolean; origin?: string; reason?: string } {
  const origin = request.headers.origin;
  if (!origin || typeof origin !== 'string') {
    return { allowed: true };
  }

  const host = request.headers.host;
  const allowed = new Set<string>();

  // Self-origin is only meaningful on loopback. For any other Host value
  // (a DNS-rebinding name, a LAN name, a tunnel/preview host) the origin
  // must be configured explicitly, because Host and Origin are both
  // supplied by the very client being policed.
  if (host && isLoopbackHost(host)) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }

  for (const entry of policy.allowedOrigins ?? []) {
    allowed.add(entry);
  }

  if (allowed.has(origin)) {
    return { allowed: true, origin };
  }

  return {
    allowed: false,
    origin,
    reason: `The origin "${origin}" is not allowed to call this proxy.`,
  };
}

/** True when a `Host` header value names this machine literally. */
function isLoopbackHost(host: string): boolean {
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0] ?? '';
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost' || normalized.endsWith('.localhost') || isLoopbackAddress(normalized);
}

/** Reject a request body that is not JSON. */
export function assertJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(
      415,
      'This endpoint only accepts "Content-Type: application/json".',
    );
  }
}

/**
 * Resolve a relative path inside a base directory.
 *
 * Returns `null` when the result would leave the directory. The check uses
 * `path.relative`, so a sibling directory whose name starts with the name of
 * the base directory is rejected as well.
 */
export function resolveWithinDirectory(baseDir: string, relativePath: string): string | null {
  if (relativePath.includes('\0')) return null;

  const base = path.resolve(baseDir);
  const candidate = path.resolve(base, relativePath);
  const relation = path.relative(base, candidate);

  if (relation === '') return candidate;
  if (relation.startsWith('..')) return null;
  if (path.isAbsolute(relation)) return null;

  return candidate;
}

/**
 * Watch for a client that goes away while a response is being written.
 *
 * The `close` event of the *request* is not usable for this: it also fires
 * when the request body was received completely, which would cancel a healthy
 * stream. The `close` event of the *response* fires when the connection is
 * gone; a response that was written completely is not a disconnect.
 */
export function watchForDisconnect(
  response: ServerResponse,
  onDisconnect: () => void,
): () => void {
  const handle = () => {
    if (!response.writableFinished) {
      onDisconnect();
    }
  };

  response.on('close', handle);
  return () => {
    response.off('close', handle);
  };
}
