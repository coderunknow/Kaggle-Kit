import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { assertPublicUrl, createPinnedLookup, isPublicAddress, normalizedHostname, type LookupAll } from './web';
import { isSensitiveField } from './policy';
import type { HttpToolSetting } from '../../shared/tools/types';

const MAX_CUSTOM_RESPONSE_BYTES = 64_000;

export class HttpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpToolError';
  }
}

export async function executeConfiguredHttpTool(
  setting: HttpToolSetting,
  args: Record<string, unknown>,
  headers: Record<string, string>,
  options: { timeoutMs: number; maxOutputBytes: number; lookup?: LookupAll; signal?: AbortSignal },
): Promise<{ ok: true; content: string; summary: string }> {
  rejectCredentialArguments(args);
  const url = await assertPublicUrl(setting.endpoint, options.lookup);
  const method = setting.method;
  let body: string | undefined;
  if (method === 'GET') {
    for (const [key, value] of Object.entries(args)) {
      for (const part of queryValues(value)) {
        url.searchParams.append(key, part);
      }
    }
  } else {
    body = JSON.stringify(args);
  }
  const response = await requestPinned(url, method, {
    ...headers,
    Accept: 'application/json, text/plain;q=0.9',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body, options.timeoutMs, Math.min(options.maxOutputBytes, MAX_CUSTOM_RESPONSE_BYTES), options.lookup, options.signal);
  if ([301, 302, 303, 307, 308].includes(response.status)) throw new HttpToolError('The configured HTTP tool returned a redirect; redirects are refused.');
  if (response.status < 200 || response.status >= 300) throw new HttpToolError(`The configured HTTP tool returned HTTP ${response.status}.`);
  if (!['application/json', 'text/plain', 'text/csv'].includes(response.contentType)) {
    throw new HttpToolError(`The configured HTTP tool returned an unsupported content type "${response.contentType || 'unknown'}".`);
  }
  const rawText = response.body.toString('utf8');
  let selected: unknown = rawText;
  if (response.contentType === 'application/json') {
    try { selected = JSON.parse(rawText); } catch { throw new HttpToolError('The configured HTTP tool returned malformed JSON.'); }
    if (setting.responsePointer !== undefined) selected = applyResponsePointer(selected, setting.responsePointer);
  }
  const content = typeof selected === 'string' ? selected : JSON.stringify(selected, null, 2);
  return { ok: true, content: content.slice(0, options.maxOutputBytes), summary: `HTTP ${method} ${safeTarget(url)}` };
}

function rejectCredentialArguments(value: unknown, depth = 0): void {
  if (depth > 16) throw new HttpToolError('Configured HTTP arguments are nested too deeply.');
  if (Array.isArray(value)) {
    for (const item of value) rejectCredentialArguments(item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveField(key)) {
      throw new HttpToolError('Credential-like HTTP arguments are refused; configure the credential as a server-side secret header reference instead.');
    }
    rejectCredentialArguments(child, depth + 1);
  }
}

function queryValues(value: unknown): string[] {
  if (value === null || value === undefined) return [''];
  if (typeof value === 'string') return [value.slice(0, 1_024)];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.slice(0, 16).flatMap(queryValues);
  return [JSON.stringify(value).slice(0, 1_024)];
}

export function applyResponsePointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let result = value;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!result || typeof result !== 'object' || ['__proto__', 'prototype', 'constructor'].includes(segment) ||
      (Array.isArray(result) && !/^(0|[1-9][0-9]*)$/.test(segment)) || !Object.prototype.hasOwnProperty.call(result, segment)) {
      throw new HttpToolError('The configured response JSON Pointer was not found.');
    }
    result = (result as Record<string, unknown>)[segment]!;
  }
  return result;
}

async function requestPinned(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  maxBytes: number,
  lookup?: LookupAll,
  signal?: AbortSignal,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (url.protocol === 'https:' && port !== 443 || url.protocol === 'http:' && port !== 80) throw new HttpToolError('Custom HTTP tools can use only standard web ports 80 and 443.');
  const hostname = normalizedHostname(url);
  const addresses = await (lookup ?? defaultLookup)(hostname);
  if (addresses.length === 0 || addresses.some((entry) => !isValidPublicIp(entry.address))) throw new HttpToolError('The configured destination resolved to a private, link-local, or reserved address.');
  const selected = addresses[0]!;
  const transport = url.protocol === 'https:' ? https : http;
  if (signal?.aborted) throw new HttpToolError('The configured HTTP request was cancelled.');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: { status: number; contentType: string; body: Buffer }) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value!);
    };
    const request = transport.request({
      protocol: url.protocol,
      hostname,
      port,
      path: `${url.pathname || '/'}${url.search}`,
      method,
      headers: { Accept: 'application/json, text/plain;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'Kaggle-Kit-tool', Host: url.host, ...headers },
      servername: url.protocol === 'https:' && !isIP(hostname) ? hostname : undefined,
      rejectUnauthorized: true,
      lookup: createPinnedLookup(selected),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new HttpToolError(`The configured HTTP response exceeded the ${maxBytes}-byte output cap.`));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('error', () => finish(new HttpToolError('The configured HTTP response was interrupted or oversized.')));
      response.on('end', () => finish(undefined, {
        status: response.statusCode ?? 0,
        contentType: (response.headers['content-type'] ?? '').toString().split(';')[0]!.trim().toLowerCase(),
        body: Buffer.concat(chunks),
      }));
    });
    const timer = setTimeout(() => request.destroy(new HttpToolError('The configured HTTP request timed out.')), Math.max(1, Math.min(30_000, timeoutMs)));
    timer.unref?.();
    const onAbort = () => request.destroy(new HttpToolError('The configured HTTP request was cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
    request.on('error', (error) => finish(error instanceof HttpToolError ? error : new HttpToolError('The configured HTTP endpoint could not be reached.')));
    if (body) request.write(body);
    request.end();
  });
}

function isValidPublicIp(address: string): boolean {
  return isPublicAddress(address);
}

async function defaultLookup(hostname: string) {
  const { lookup } = await import('node:dns/promises');
  const values = await lookup(hostname, { all: true, verbatim: true });
  return values.map((value) => ({ address: value.address, family: value.family as 4 | 6 }));
}

function safeTarget(url: URL): string { return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 256); }
