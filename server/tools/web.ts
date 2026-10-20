import { lookup as nodeLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { URL } from 'node:url';
import type { SourceCitation } from '../../shared/tools/types';
import { APP_USER_AGENT } from '../../shared/version';

export const WEB_PAGE_BYTES_LIMIT = 1_000_000;
export const WEB_TEXT_CHAR_LIMIT = 20_000;
export const WEB_TIMEOUT_MS = 12_000;
export const WEB_MAX_REDIRECTS = 3;
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const USER_AGENT = APP_USER_AGENT;

export class WebToolError extends Error {
  constructor(message: string, readonly kind: 'invalid' | 'blocked' | 'timeout' | 'provider' | 'response' = 'provider') {
    super(message);
    this.name = 'WebToolError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>;

export function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

const lookupAll: LookupAll = async (hostname) => {
  const results = await nodeLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
};

/** Match both callback forms Node may request when autoSelectFamily is enabled. */
export function createPinnedLookup(selected: ResolvedAddress): NonNullable<http.RequestOptions['lookup']> {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [selected]);
    else callback(null, selected.address, selected.family);
  };
}

/** Reject special-use and non-global ranges before a socket is opened. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = octets as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split('%')[0]!;
    if (normalized === '::' || normalized === '::1') return false;
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice(7);
      return isIP(mapped) === 4 && isPublicAddress(mapped);
    }
    // Only global unicast is accepted. ULA, link-local, multicast, documentation,
    // transition, benchmarking, and other special-purpose ranges are refused.
    if (!/^2[0-9a-f]{3}:/.test(normalized) && !/^3[0-9a-f]{3}:/.test(normalized)) return false;
    const first = Number.parseInt(normalized.split(':')[0] ?? '', 16);
    const secondText = normalized.slice(normalized.indexOf(':') + 1).split(':')[0] ?? '';
    const second = secondText ? Number.parseInt(secondText, 16) : 0;
    if (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) return false; // IANA special-purpose /23 and documentation
    if (first === 0x2002 || first === 0x3ffe) return false; // 6to4 and deprecated 6bone
    if (first === 0x3fff && second <= 0x0fff) return false; // documentation range
    return true;
  }
  return false;
}

export async function assertPublicUrl(raw: string, lookup: LookupAll = lookupAll): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebToolError('The URL is not valid.', 'invalid'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebToolError('Only HTTP and HTTPS pages can be opened.', 'blocked');
  if (url.username || url.password || hasCredentialQuery(url)) {
    throw new WebToolError('URLs containing credentials or credential-like query parameters are refused.', 'blocked');
  }
  if (url.hash) url.hash = '';
  if (url.port && !['80', '443'].includes(url.port)) throw new WebToolError('Only standard web ports 80 and 443 are allowed.', 'blocked');
  const host = normalizedHostname(url);
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test') || host === 'metadata.google.internal' || host === 'instance-data') {
    throw new WebToolError('Loopback, local, metadata, and reserved host names are refused.', 'blocked');
  }
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new WebToolError('Private, link-local, loopback, and reserved IP addresses are refused.', 'blocked');
    return url;
  }
  let addresses: ResolvedAddress[];
  try { addresses = await lookup(host); } catch { throw new WebToolError('The destination host could not be resolved.', 'blocked'); }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new WebToolError('The destination resolves to a private, link-local, loopback, or reserved address.', 'blocked');
  }
  return url;
}

interface PinnedResponse {
  status: number;
  contentType: string;
  location?: string;
  body: Buffer;
}

async function requestPinned(
  url: URL,
  options: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; lookup?: LookupAll; signal?: AbortSignal },
): Promise<PinnedResponse> {
  const hostname = normalizedHostname(url);
  const addressFamily = isIP(hostname);
  const addresses = addressFamily
    ? [{ address: hostname, family: addressFamily as 4 | 6 }]
    : await (options.lookup ?? lookupAll)(hostname);
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new WebToolError('The destination no longer resolves to a public address.', 'blocked');
  }
  const selected = addresses[0]!;
  if (options.signal?.aborted) throw new WebToolError('The public web request was cancelled.', 'timeout');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (url.protocol === 'https:' && port !== 443 || url.protocol === 'http:' && port !== 80) {
    throw new WebToolError('Only standard web ports 80 and 443 are allowed.', 'blocked');
  }
  const transport = url.protocol === 'https:' ? https : http;
  const maxBytes = options.maxBytes ?? WEB_PAGE_BYTES_LIMIT;
  const timeoutMs = options.timeoutMs ?? WEB_TIMEOUT_MS;

  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: PinnedResponse) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value!);
    };
    const request = transport.request({
      protocol: url.protocol,
      hostname,
      port,
      path: `${url.pathname || '/'}${url.search}`,
      method: 'GET',
      headers: {
        Accept: 'text/html, text/plain, application/xhtml+xml, application/json;q=0.9',
        'Accept-Encoding': 'identity',
        'User-Agent': USER_AGENT,
        Host: url.host,
        ...options.headers,
      },
      servername: addressFamily ? undefined : hostname,
      rejectUnauthorized: true,
      lookup: createPinnedLookup(selected),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new WebToolError(`The response exceeded the ${maxBytes}-byte limit.`, 'response'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('error', (error) => finish(error instanceof WebToolError ? error : new WebToolError('The web response could not be read.', 'response')));
      response.on('end', () => finish(undefined, {
        status: response.statusCode ?? 0,
        contentType: (response.headers['content-type'] ?? '').toString().split(';')[0]!.trim().toLowerCase(),
        ...(response.headers.location ? { location: response.headers.location.toString() } : {}),
        body: Buffer.concat(chunks),
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new WebToolError(`The web request timed out after ${Math.round(timeoutMs / 1000)} seconds.`, 'timeout')));
    const onAbort = () => request.destroy(new WebToolError('The public web request was cancelled.', 'timeout'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    request.on('close', () => options.signal?.removeEventListener('abort', onAbort));
    request.on('error', (error) => finish(error instanceof WebToolError ? error : new WebToolError('The public web destination could not be reached.', 'provider')));
    request.end();
  });
}

export async function braveSearch(query: string, apiKey: string, maxResults = 5, lookup?: LookupAll, signal?: AbortSignal): Promise<{ provider: string; query: string; results: Array<{ title: string; url: string; description: string; age?: string }> }> {
  if (!apiKey.trim()) throw new WebToolError('Brave Search is not configured: add a server-side API key in Tools settings.', 'provider');
  if (query.trim().length < 2 || query.length > 400) throw new WebToolError('Search query must be 2–400 characters.', 'invalid');
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', query.trim());
  url.searchParams.set('count', String(Math.max(1, Math.min(8, Math.floor(maxResults)))));
  const validated = await assertPublicUrl(url.toString(), lookup);
  let response: PinnedResponse;
  try {
    response = await requestPinned(validated, { lookup, signal, timeoutMs: WEB_TIMEOUT_MS, maxBytes: 512_000, headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } });
  } catch (error) {
    if (error instanceof WebToolError) throw error;
    throw new WebToolError('Brave Search could not be reached. Check provider connectivity.', 'provider');
  }
  if (response.status === 401 || response.status === 403) throw new WebToolError('Brave Search rejected the configured API key.', 'provider');
  if (response.status === 429) throw new WebToolError('Brave Search rate limit was reached. Check the provider plan and quota.', 'provider');
  if (response.status < 200 || response.status >= 300) throw new WebToolError(`Brave Search returned HTTP ${response.status}.`, 'provider');
  if (response.contentType !== 'application/json') throw new WebToolError('Brave Search returned an unexpected content type.', 'response');
  let payload: unknown;
  try { payload = JSON.parse(response.body.toString('utf8')); } catch { throw new WebToolError('Brave Search returned malformed JSON.', 'response'); }
  const web = payload && typeof payload === 'object' ? (payload as { web?: { results?: unknown[] } }).web : undefined;
  const results = (web?.results ?? []).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const link = typeof item.url === 'string' ? validCitationUrl(item.url) : null;
    if (!link) return [];
    const snippet = Array.isArray(item.extra_snippets) ? item.extra_snippets[0] : undefined;
    return [{
      title: safeText(item.title, 240),
      url: link,
      description: safeText(item.description ?? snippet, 800),
      ...(typeof item.age === 'string' ? { age: safeText(item.age, 80) } : {}),
    }];
  }).slice(0, 8);
  return { provider: 'Brave Search', query: query.trim(), results };
}

export async function validatePublicRedirect(current: URL, location: string, lookup: LookupAll = lookupAll): Promise<URL> {
  let target: string;
  try { target = new URL(location, current).toString(); } catch {
    throw new WebToolError('The redirect location is not a valid URL.', 'blocked');
  }
  const next = await assertPublicUrl(target, lookup);
  if (current.protocol === 'https:' && next.protocol !== 'https:') {
    throw new WebToolError('HTTPS-to-HTTP redirect downgrade is refused.', 'blocked');
  }
  return next;
}

export async function retrievePublicPage(rawUrl: string, lookup?: LookupAll, signal?: AbortSignal): Promise<{ text: string; citation: SourceCitation; contentType: string }> {
  let current = await assertPublicUrl(rawUrl, lookup);
  let response: PinnedResponse | undefined;
  for (let hop = 0; hop <= WEB_MAX_REDIRECTS; hop += 1) {
    // Revalidate after resolving immediately before every connection. The socket
    // is pinned to one validated address, avoiding DNS rebinding between check/use.
    await assertPublicUrl(current.toString(), lookup);
    response = await requestPinned(current, { lookup, signal, maxBytes: WEB_PAGE_BYTES_LIMIT, timeoutMs: WEB_TIMEOUT_MS });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      if (hop === WEB_MAX_REDIRECTS) throw new WebToolError('The page redirected too many times.', 'blocked');
      current = await validatePublicRedirect(current, response.location, lookup);
      continue;
    }
    break;
  }
  if (!response) throw new WebToolError('The page returned no response.', 'response');
  if (response.status < 200 || response.status >= 300) throw new WebToolError(`The page returned HTTP ${response.status}.`, 'response');
  if (!['text/html', 'application/xhtml+xml', 'text/plain', 'application/json'].includes(response.contentType)) {
    throw new WebToolError(`Unsupported web content type "${response.contentType || 'unknown'}".`, 'response');
  }
  const rawText = response.body.toString('utf8');
  const { title, text } = response.contentType === 'text/plain' || response.contentType === 'application/json'
    ? { title: '', text: rawText }
    : extractHtml(rawText);
  const bounded = text.trim().slice(0, WEB_TEXT_CHAR_LIMIT);
  if (!bounded) throw new WebToolError('The retrieved page contained no readable text.', 'response');
  return {
    text: bounded,
    contentType: response.contentType,
    citation: {
      url: current.toString(),
      ...(title ? { title: safeText(title, 240) } : {}),
      publisher: current.hostname,
      retrievedAt: new Date().toISOString(),
    },
  };
}

function hasCredentialQuery(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized === 'auth' || normalized === 'jwt' || normalized === 'sig' || normalized === 'key' ||
      normalized.endsWith('apikey') || normalized.endsWith('accesskey') || normalized.endsWith('accesskeyid') || normalized.endsWith('authorization') ||
      normalized.endsWith('token') || normalized.endsWith('secret') ||
      normalized.endsWith('password') || normalized.endsWith('passwd') ||
      normalized.endsWith('credential') || normalized.endsWith('signature')) return true;
  }
  return false;
}

function validCitationUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || hasCredentialQuery(url)) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function safeText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  }).join('').slice(0, limit);
}

const SKIPPED_HTML_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'form']);
const BLOCK_HTML_TAGS = new Set(['br', 'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'section', 'article']);

export function extractHtml(html: string): { title: string; text: string } {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let title = '';
  let index = 0;
  while (index < html.length) {
    const opening = html.indexOf('<', index);
    if (opening < 0) {
      parts.push(html.slice(index));
      break;
    }
    if (opening > index) parts.push(html.slice(index, opening));
    if (html.startsWith('<!--', opening)) {
      const commentEnd = html.indexOf('-->', opening + 4);
      if (commentEnd < 0) break;
      index = commentEnd + 3;
      continue;
    }
    const tagEnd = findHtmlTagEnd(html, opening + 1);
    if (tagEnd < 0) {
      parts.push(html.slice(opening));
      break;
    }
    const tag = parseHtmlTag(html.slice(opening + 1, tagEnd));
    if (!tag) {
      parts.push(' ');
      index = tagEnd + 1;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && tag.name === 'title') {
      const closing = findClosingHtmlTag(html, lower, 'title', tagEnd + 1);
      if (closing) {
        title = extractHtmlText(html.slice(tagEnd + 1, closing.start)).trim();
        index = closing.end + 1;
        continue;
      }
      title = extractHtmlText(html.slice(tagEnd + 1)).trim();
      break;
    }
    if (!tag.closing && !tag.selfClosing && SKIPPED_HTML_TAGS.has(tag.name)) {
      const closing = findClosingHtmlTag(html, lower, tag.name, tagEnd + 1);
      if (!closing) break;
      index = closing.end + 1;
      continue;
    }
    parts.push(BLOCK_HTML_TAGS.has(tag.name) ? '\n' : ' ');
    index = tagEnd + 1;
  }
  return { title, text: normalizeHtmlText(parts.join('')) };
}

function extractHtmlText(html: string): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let index = 0;
  while (index < html.length) {
    const opening = html.indexOf('<', index);
    if (opening < 0) {
      parts.push(html.slice(index));
      break;
    }
    if (opening > index) parts.push(html.slice(index, opening));
    if (html.startsWith('<!--', opening)) {
      const commentEnd = html.indexOf('-->', opening + 4);
      if (commentEnd < 0) break;
      index = commentEnd + 3;
      continue;
    }
    const tagEnd = findHtmlTagEnd(html, opening + 1);
    if (tagEnd < 0) {
      parts.push(html.slice(opening));
      break;
    }
    const tag = parseHtmlTag(html.slice(opening + 1, tagEnd));
    if (!tag) {
      parts.push(' ');
      index = tagEnd + 1;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && SKIPPED_HTML_TAGS.has(tag.name)) {
      const closing = findClosingHtmlTag(html, lower, tag.name, tagEnd + 1);
      if (!closing) break;
      index = closing.end + 1;
      continue;
    }
    parts.push(BLOCK_HTML_TAGS.has(tag.name) ? '\n' : ' ');
    index = tagEnd + 1;
  }
  return normalizeHtmlText(parts.join(''));
}

function findHtmlTagEnd(html: string, start: number): number {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]!;
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseHtmlTag(raw: string): { name: string; closing: boolean; selfClosing: boolean } | null {
  const value = raw.trim();
  if (!value || value.startsWith('!') || value.startsWith('?')) return null;
  const closing = value.startsWith('/');
  const content = closing ? value.slice(1).trimStart() : value;
  const match = /^([a-z][a-z0-9:-]*)\b/i.exec(content);
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), closing, selfClosing: !closing && /\/\s*$/.test(content) };
}

function findClosingHtmlTag(html: string, lower: string, name: string, start: number): { start: number; end: number } | null {
  const needle = `</${name}`;
  let searchFrom = start;
  for (;;) {
    const closingStart = lower.indexOf(needle, searchFrom);
    if (closingStart < 0) return null;
    const boundary = lower[closingStart + needle.length];
    if (boundary === '>' || boundary === '/' || boundary === undefined || /\s/.test(boundary)) {
      const end = findHtmlTagEnd(html, closingStart + needle.length);
      if (end >= 0) return { start: closingStart, end };
    }
    searchFrom = closingStart + needle.length;
  }
}

function normalizeHtmlText(value: string): string {
  return decodeEntities(value).replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
}
function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const number = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '\uFFFD';
  });
}
