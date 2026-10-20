import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { McpDiscoveredTool, McpServerSetting } from '../../shared/tools/types';
import { APP_VERSION } from '../../shared/version';
import { assertPublicUrl, createPinnedLookup, isPublicAddress, normalizedHostname, type LookupAll } from './web';
import { sanitizeDiscoveredSchema } from './policy';

const MAX_MCP_REQUEST_BYTES = 1_000_000;
const MAX_MCP_RESPONSE_BYTES = 1_000_000;

export class McpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

interface McpConnectionOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  lookup?: LookupAll;
}

export async function discoverMcpTools(
  server: McpServerSetting,
  options: McpConnectionOptions,
): Promise<McpDiscoveredTool[]> {
  if (server.transport !== 'streamable_http' || !server.url) {
    throw new McpConnectionError('Only remote Streamable HTTP MCP servers are supported. Local stdio execution is disabled.');
  }
  const { client, transport } = await connect(server.url, options);
  try {
    const result = await client.listTools({}, {
      cacheMode: 'bypass',
      timeout: boundedTimeout(options.timeoutMs),
      maxTotalTimeout: boundedTimeout(options.timeoutMs),
    });
    if (!Array.isArray(result.tools)) throw new McpConnectionError('The MCP server returned an invalid tool list.');
    return result.tools.slice(0, 64).flatMap((tool) => {
      const name = typeof tool.name === 'string' ? tool.name.trim() : '';
      const inputSchema = sanitizeDiscoveredSchema(tool.inputSchema);
      if (!name || name.length > 128 || !inputSchema) return [];
      return [{
        name: safeText(tool.title ?? name, 80),
        serverToolName: name,
        description: safeText(tool.description ?? '', 500),
        inputSchema,
        selected: false,
        permission: 'unknown' as const,
      }];
    });
  } catch (error) {
    if (error instanceof McpConnectionError) throw error;
    throw new McpConnectionError('The MCP server did not return a valid tools/list response. Check its endpoint and connection grant.');
  } finally {
    await closeClient(client, transport);
  }
}

export async function callMcpTool(
  server: McpServerSetting,
  configured: McpDiscoveredTool,
  args: Record<string, unknown>,
  options: McpConnectionOptions & { signal?: AbortSignal },
): Promise<{ ok: true; content: string; summary: string }> {
  if (!server.confirmed || !server.enabled || server.transport !== 'streamable_http' || !server.url) {
    throw new McpConnectionError('This MCP server connection has not been granted or enabled.');
  }
  const { client, transport } = await connect(server.url, options);
  try {
    const listed = await client.listTools({}, {
      cacheMode: 'bypass',
      timeout: boundedTimeout(options.timeoutMs),
      maxTotalTimeout: boundedTimeout(options.timeoutMs),
      signal: options.signal,
    });
    const actual = listed.tools.find((tool) => tool.name === configured.serverToolName);
    if (!actual) throw new McpConnectionError('The MCP tool is no longer available. Re-discover and review this connection.');
    const actualSchema = sanitizeDiscoveredSchema(actual.inputSchema);
    if (!actualSchema || stableStringify(actualSchema) !== stableStringify(configured.inputSchema)) {
      throw new McpConnectionError('The MCP tool schema changed since it was reviewed. Re-discover and approve the updated tool.');
    }
    const result = await client.callTool({ name: configured.serverToolName, arguments: args }, {
      timeout: boundedTimeout(options.timeoutMs),
      maxTotalTimeout: boundedTimeout(options.timeoutMs),
      signal: options.signal,
    });
    if (result.isError) throw new McpConnectionError(formatMcpContent(result, true) || 'The MCP tool reported an error.');
    const content = formatMcpContent(result, false);
    return { ok: true, content: content || 'The MCP tool returned no text output.', summary: safeText(actual.title ?? actual.name, 120) };
  } catch (error) {
    if (error instanceof McpConnectionError) throw error;
    if (options.signal?.aborted) throw new McpConnectionError('The MCP tool call was cancelled.');
    throw new McpConnectionError('The MCP server call failed or exceeded its time limit.');
  } finally {
    await closeClient(client, transport);
  }
}

async function connect(urlText: string, options: McpConnectionOptions): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const url = await assertPublicUrl(urlText, options.lookup);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) {
    throw new McpConnectionError('Remote MCP connections must use public HTTPS on port 443.');
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { redirect: 'error', headers: options.headers },
    fetch: (input, init) => pinnedMcpFetch(input, init, options),
    redirectPolicy: 'same-origin',
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 1_000,
      initialReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
    },
    onInsufficientScope: 'throw',
  });
  const client = new Client({ name: 'Kaggle-Kit', version: APP_VERSION }, { enforceStrictCapabilities: true });
  try {
    await client.connect(transport, { timeout: boundedTimeout(options.timeoutMs) });
    return { client, transport };
  } catch {
    await closeClient(client, transport);
    throw new McpConnectionError('The MCP server could not be connected. No tool was run.');
  }
}

async function closeClient(client: Client, transport: StreamableHTTPClientTransport): Promise<void> {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
}

async function pinnedMcpFetch(input: string | URL | Request, init: RequestInit | undefined, options: McpConnectionOptions): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const rawUrl = input instanceof URL ? input.toString() : request?.url ?? String(input);
  const url = await assertPublicUrl(rawUrl, options.lookup);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) throw new McpConnectionError('MCP requests must use public HTTPS on port 443.');
  if (init?.redirect === 'follow' || init?.redirect === 'manual') throw new McpConnectionError('Redirects are disabled for MCP connections.');
  const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'DELETE'].includes(method)) throw new McpConnectionError('The MCP transport requested an unsupported HTTP method.');
  let requestPayload = init?.body;
  if (requestPayload === undefined && request && method !== 'GET' && request.body) {
    requestPayload = await request.arrayBuffer();
  }
  const body = await requestBody(requestPayload);
  if (body && body.byteLength > MAX_MCP_REQUEST_BYTES) throw new McpConnectionError('The MCP request exceeded the 1 MiB limit.');
  const headers = new Headers(request?.headers);
  if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const headerRecord: Record<string, string> = {};
  headers.forEach((value, name) => { headerRecord[name] = value; });
  for (const [name, value] of Object.entries(options.headers)) {
    if (!headers.has(name)) headerRecord[name] = value;
  }
  const hostname = normalizedHostname(url);
  const addresses = await (options.lookup ?? defaultLookup)(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address.address))) {
    throw new McpConnectionError('The MCP destination resolved to a non-public address.');
  }
  const selected = addresses[0]!;
  const port = url.port ? Number(url.port) : 443;
  const signal = init?.signal ?? request?.signal;
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: Response) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value!);
    };
    const transport = url.protocol === 'https:' ? https : http;
    const outgoing = transport.request({
      protocol: url.protocol,
      hostname,
      port,
      path: `${url.pathname || '/'}${url.search}`,
      method,
      headers: { Accept: 'application/json, text/event-stream', 'Accept-Encoding': 'identity', 'User-Agent': `Kaggle-Kit/${APP_VERSION}`, Host: url.host, ...headerRecord },
      servername: isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: true,
      lookup: createPinnedLookup(selected),
    }, (incoming) => {
      const status = incoming.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        incoming.resume();
        return finish(new McpConnectionError('MCP redirects are refused.'));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_MCP_RESPONSE_BYTES) {
          incoming.destroy(new McpConnectionError('The MCP response exceeded the 1 MiB limit.'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      incoming.on('error', () => finish(new McpConnectionError('The MCP response was interrupted.')));
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers as IncomingHttpHeaders)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (typeof value === 'string') responseHeaders.set(name, value);
        }
        try {
          const payload = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
          finish(undefined, new Response(payload, { status, headers: responseHeaders }));
        } catch {
          finish(new McpConnectionError('The MCP server returned an invalid HTTP response.'));
        }
      });
    });
    const timer = setTimeout(() => outgoing.destroy(new McpConnectionError(`The MCP request timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`)), boundedTimeout(options.timeoutMs));
    timer.unref?.();
    const onAbort = () => outgoing.destroy(new McpConnectionError('The MCP request was cancelled.'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    outgoing.on('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
    outgoing.on('error', (error) => finish(error instanceof McpConnectionError ? error : new McpConnectionError('The MCP destination could not be reached.')));
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

async function requestBody(body: RequestInit['body']): Promise<Buffer | undefined> {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new McpConnectionError('The MCP transport requested an unsupported request body type.');
}

function formatMcpContent(result: { content?: Array<{ type?: string; text?: string }> ; structuredContent?: unknown }, includeError: boolean): string {
  const text = (result.content ?? []).flatMap((part) => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []);
  if (text.length) return text.join('\n').slice(0, MAX_MCP_RESPONSE_BYTES);
  if (includeError && result.structuredContent) return safeText(JSON.stringify(result.structuredContent), 8_000);
  return '';
}

function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  }).join('').replace(/\s+/g, ' ').trim().slice(0, max);
}

function boundedTimeout(value: number): number { return Math.max(1_000, Math.min(30_000, Math.floor(value))); }

async function defaultLookup(hostname: string) {
  const { lookup } = await import('node:dns/promises');
  const values = await lookup(hostname, { all: true, verbatim: true });
  return values.map((value) => ({ address: value.address, family: value.family as 4 | 6 }));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
