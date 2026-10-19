/**
 * URL helpers for OpenAI-compatible base URLs.
 *
 * The chat client never hardcodes an endpoint. Users paste whatever base URL
 * their deployment exposes (for example a temporary Cloudflare Quick Tunnel
 * URL). These helpers make the value safe to use:
 *
 *  - a missing scheme is upgraded to `https://`
 *  - a duplicated `/v1` suffix is never created
 *  - trailing slashes are removed
 *  - a pasted `/chat/completions` endpoint is reduced to its base
 *  - query strings and fragments are rejected
 */

export class UrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlValidationError';
  }
}

const V1_SUFFIX = /\/v1$/i;
const COMPLETIONS_SUFFIX = /\/(chat\/)?completions$/i;
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export interface NormalizedBaseUrl {
  /** The canonical base URL, always ending in `/v1` and never with a slash. */
  baseUrl: string;
  /** True when the normalized value differs from the raw input. */
  changed: boolean;
  /** Human readable notes explaining what was adjusted. */
  notes: string[];
}

/**
 * Normalize a user supplied base URL.
 *
 * @throws {UrlValidationError} when the value cannot be used as a base URL.
 */
export function normalizeBaseUrl(raw: string): string {
  return normalizeBaseUrlDetailed(raw).baseUrl;
}

/**
 * Normalize a user supplied base URL and report what was changed, so the UI
 * can show the user exactly how their input was interpreted.
 */
export function normalizeBaseUrlDetailed(raw: string): NormalizedBaseUrl {
  const notes: string[] = [];
  const trimmed = (raw ?? '').trim();

  if (!trimmed) {
    throw new UrlValidationError('Base URL is required.');
  }
  if (/\s/.test(trimmed)) {
    throw new UrlValidationError('Base URL must not contain whitespace.');
  }

  const hadScheme = HAS_SCHEME.test(trimmed);
  const candidate = hadScheme ? trimmed : `https://${trimmed}`;

  if (!hadScheme) {
    notes.push('Added the default "https://" scheme.');
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new UrlValidationError(`"${trimmed}" is not a valid URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlValidationError('Base URL must use the http:// or https:// scheme.');
  }
  if (url.username || url.password) {
    throw new UrlValidationError('Base URL must not embed credentials.');
  }
  if (url.search) {
    throw new UrlValidationError('Base URL must not contain a query string.');
  }
  if (url.hash) {
    throw new UrlValidationError('Base URL must not contain a fragment.');
  }

  let path = url.pathname.replace(/\/+$/, '');

  if (COMPLETIONS_SUFFIX.test(path)) {
    path = path.replace(COMPLETIONS_SUFFIX, '');
    path = path.replace(/\/+$/, '');
    notes.push('Removed the pasted completions endpoint and used its base URL.');
  }

  if (/(?:\/v1){2,}$/i.test(path)) {
    path = path.replace(/(?:\/v1)+$/i, '/v1');
    notes.push('Removed a duplicated "/v1" suffix.');
  }

  if (!path || path === '') {
    path = '/v1';
    notes.push('Added the "/v1" API prefix.');
  } else if (!V1_SUFFIX.test(path)) {
    path = `${path}/v1`;
    notes.push('Added the "/v1" API prefix.');
  }

  const baseUrl = `${url.protocol}//${url.host}${path}`;

  if (baseUrl !== trimmed) {
    notes.push(`Normalized to ${baseUrl}.`);
  }

  return { baseUrl, changed: baseUrl !== trimmed, notes };
}

/** Join a normalized base URL with an API path such as `/models`. */
export function joinApiPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Returns true when the URL points at a Cloudflare Quick Tunnel host.
 * Quick Tunnels are temporary and do not support SSE streaming, which the UI
 * surfaces as a warning.
 */
export function isQuickTunnelUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith('.trycloudflare.com');
  } catch {
    return false;
  }
}
