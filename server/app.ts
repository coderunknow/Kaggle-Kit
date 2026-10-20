/**
 * The local proxy backend.
 *
 * Responsibilities:
 *  - serve the built browser client
 *  - proxy OpenAI-compatible calls to the configured model server
 *  - keep API keys out of the browser when the user opts into the "server"
 *    credential mode
 *  - verify streaming support before offering a streaming toggle
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { ApiError, redactSecrets } from '../shared/api/errors';
import { joinApiPath } from '../shared/api/url';
import type { ChatCompletionRequestBody, ChatMessageInput } from '../shared/api/types';
import { parseInferenceParams } from '../shared/api/validation';
import { loadServerConfig, type ServerConfig } from './config';
import { createLogger, type Logger } from './logger';
import { HttpError, readJsonBody, sendError, sendJson } from './http';
import { ProxyService } from './proxy';
import {
  assertJsonContentType,
  isAllowedOrigin,
  resolveWithinDirectory,
  watchForDisconnect,
} from './requestPolicy';
import { SecretStore } from './secrets';
import { FileVault, MAX_UPLOAD_BYTES, FileProcessingError } from './tools/files';
import { ToolExecutor, ToolExecutionError } from './tools/executor';
import { ToolChatService, validateToolChatMessages } from './tools/chat';
import { discoverMcpTools, McpConnectionError } from './tools/mcp';
import { grantMcpServer, sanitizeToolProfileForStorage, ToolPolicyError } from './tools/policy';
import { WebToolError } from './tools/web';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface AppOptions {
  config?: ServerConfig;
  logger?: Logger;
}

export interface App {
  server: http.Server;
  config: ServerConfig;
  logger: Logger;
  store: SecretStore;
  proxy: ProxyService;
  files: FileVault;
  toolChat: ToolChatService;
}

export function createApp(options: AppOptions = {}): App {
  const config = options.config ?? loadServerConfig();
  const logger = options.logger ?? createLogger({ verbose: config.verbose });
  const store = new SecretStore(config.secretsFile);
  const proxy = new ProxyService(config, store, logger);
  const files = new FileVault();
  const toolExecutor = new ToolExecutor(store, proxy, files, logger);
  const toolChat = new ToolChatService(store, proxy, toolExecutor);

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      logger.error('Unhandled request failure', { message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) {
        sendError(response, 500, 'The proxy failed to handle the request.');
      } else {
        response.end();
      }
    });
  });

  async function handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const method = (request.method ?? 'GET').toUpperCase();

    setSecurityHeaders(response);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url, method);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendError(response, 405, 'Only GET requests are supported for this path.');
      return;
    }

    await serveStatic(url.pathname, response, config.clientDir);
  }

  async function handleApi(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    method: string,
  ): Promise<void> {
    const route = `${method} ${url.pathname}`;

    try {
      // A browser page on another origin must not be able to use this proxy.
      const origin = isAllowedOrigin(request, { allowedOrigins: config.allowedOrigins });
      if (!origin.allowed) {
        sendError(response, 403, origin.reason ?? 'The origin is not allowed.', {
          kind: 'bad_request',
        });
        return;
      }

      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        assertJsonContentType(request);
      }

      switch (route) {
        case 'GET /api/health': {
          // The allow list and other configuration stay on the server: the
          // browser only needs to know that the proxy is alive.
          sendJson(response, 200, { ok: true, name: 'kaggle-kit-proxy' });
          return;
        }

        case 'GET /api/secrets': {
          const references = await store.list();
          sendJson(response, 200, { references });
          return;
        }

        case 'POST /api/secrets': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const reference = typeof body.ref === 'string' ? body.ref.trim() : '';
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(reference)) throw new HttpError(400, 'The key reference must contain 1–128 safe identifier characters.');
          if (!apiKey) throw new HttpError(400, 'The API key must not be empty.');
          if (apiKey.length > 16_384) throw new HttpError(413, 'The key is too long to store.');
          await store.set(reference, apiKey);
          logger.info('Stored an API key in the local secret store');
          sendJson(response, 200, { ok: true, ref: reference });
          return;
        }

        case 'POST /api/proxy/models': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const models = await proxy.listModels(
            { baseUrl: readString(body, 'baseUrl'), apiKey: readOptionalString(body, 'apiKey'), secretRef: readOptionalString(body, 'secretRef') },
            readTimeout(body),
          );
          sendJson(response, 200, { models });
          return;
        }

        case 'POST /api/proxy/test': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const result = await proxy.testConnection(
            { baseUrl: readString(body, 'baseUrl'), apiKey: readOptionalString(body, 'apiKey'), secretRef: readOptionalString(body, 'secretRef') },
            { model: readOptionalString(body, 'model'), timeoutMs: readTimeout(body) },
          );
          sendJson(response, 200, result);
          return;
        }

        case 'POST /api/proxy/probe-stream': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const result = await proxy.probeStreaming(
            { baseUrl: readString(body, 'baseUrl'), apiKey: readOptionalString(body, 'apiKey'), secretRef: readOptionalString(body, 'secretRef') },
            { model: readOptionalString(body, 'model'), timeoutMs: readTimeout(body) },
          );
          sendJson(response, 200, result);
          return;
        }

        case 'POST /api/proxy/chat': {
          await handleChat(request, response);
          return;
        }

        case 'POST /api/tools/capability': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const result = await proxy.probeToolCalling(readTarget(body), {
            model: readOptionalString(body, 'model'),
            timeoutMs: readTimeout(body),
            force: true,
          });
          sendJson(response, 200, result);
          return;
        }

        case 'GET /api/tools/profile': {
          const profileId = readQueryId(url, 'profileId');
          sendJson(response, 200, { settings: await store.getToolProfile(profileId) });
          return;
        }

        case 'DELETE /api/tools/profile': {
          const profileId = readQueryId(url, 'profileId');
          toolChat.cancelProfile(profileId);
          const deleted = await store.deleteToolProfile(profileId);
          sendJson(response, deleted ? 200 : 404, { ok: deleted });
          return;
        }

        case 'PUT /api/tools/profile': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const profileId = readId(body, 'profileId');
          const previous = await store.getToolProfile(profileId);
          const settings = sanitizeToolProfileForStorage(body.settings, previous);
          await assertToolSecretsExist(settings, store);
          await store.setToolProfile(profileId, settings, { preserveGrantedMcpServers: true });
          sendJson(response, 200, { ok: true, settings });
          return;
        }

        case 'POST /api/tools/mcp/discover': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const profileId = readId(body, 'profileId');
          const serverId = readId(body, 'serverId');
          const settings = await store.getToolProfile(profileId);
          const serverSetting = settings?.mcpServers.find((entry) => entry.id === serverId);
          if (!settings || !serverSetting) throw new HttpError(404, 'The configured MCP server was not found.');
          const headers = await resolveStoredHeaders(serverSetting.headers ?? [], store, logger);
          const tools = await discoverMcpTools(serverSetting, { headers, timeoutMs: serverSetting.timeoutMs });
          const mcpServers = settings.mcpServers.map((entry) => entry.id === serverId
            ? { ...entry, enabled: false, confirmed: false, tools }
            : entry);
          const updated = { ...settings, mcpServers };
          await store.setToolProfile(profileId, updated, { preserveGrantedMcpServers: true });
          sendJson(response, 200, { tools, granted: false, message: 'Tools were discovered but not granted. Review the list and explicitly grant the connection.' });
          return;
        }

        case 'POST /api/tools/mcp/grant': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const profileId = readId(body, 'profileId');
          const serverId = readId(body, 'serverId');
          const settings = await store.getToolProfile(profileId);
          if (!settings) throw new HttpError(404, 'The tool profile was not found.');
          const granted = grantMcpServer(settings, serverId);
          await store.setToolProfile(profileId, granted, { preserveGrantedMcpServers: true });
          sendJson(response, 200, { ok: true, settings: granted });
          return;
        }

        case 'POST /api/tools/files/upload': {
          const maxUploadBody = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 64_000;
          const body = await readJsonBody(request, maxUploadBody);
          const conversationId = readId(body, 'conversationId');
          const name = readString(body, 'name');
          const mediaType = readOptionalString(body, 'mediaType') ?? 'application/octet-stream';
          const encoded = readString(body, 'contentBase64');
          const bytes = decodeUpload(encoded);
          const file = await files.upload({ name, mediaType, bytes, conversationId });
          sendJson(response, 201, { file });
          return;
        }

        case 'GET /api/tools/files': {
          const conversationId = readQueryId(url, 'conversationId');
          sendJson(response, 200, { files: files.list(conversationId) });
          return;
        }

        case 'DELETE /api/tools/files': {
          const conversationId = readQueryId(url, 'conversationId');
          toolChat.cancelConversation(conversationId);
          files.removeConversation(conversationId);
          sendJson(response, 200, { ok: true });
          return;
        }

        case 'POST /api/tools/chat': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const controller = new AbortController();
          const stopWatching = watchForDisconnect(response, () => controller.abort());
          try {
            const parsed = parseInferenceParams(body.params);
            const result = await toolChat.start({
              profileId: readId(body, 'profileId'),
              conversationId: readId(body, 'conversationId'),
              target: readTarget(body),
              model: readOptionalString(body, 'model') ?? '',
              messages: validateToolChatMessages(body.messages),
              params: parsed.params,
              timeoutMs: readTimeout(body),
              ...(body.conversationSettings && typeof body.conversationSettings === 'object'
                ? { conversationSettings: body.conversationSettings as never }
                : {}),
            }, controller.signal);
            sendJson(response, 200, result);
          } finally {
            stopWatching();
          }
          return;
        }

        case 'POST /api/tools/approve': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const controller = new AbortController();
          const stopWatching = watchForDisconnect(response, () => controller.abort());
          try {
            const result = await toolChat.approve({
              jobId: readId(body, 'jobId'),
              approvalId: readId(body, 'approvalId'),
              approved: body.approved === true,
            }, controller.signal);
            sendJson(response, 200, result);
          } finally {
            stopWatching();
          }
          return;
        }

        case 'POST /api/tools/cancel': {
          const body = await readJsonBody(request, config.maxBodyBytes);
          const cancelled = toolChat.cancel(readId(body, 'jobId'));
          sendJson(response, cancelled ? 200 : 404, { ok: cancelled });
          return;
        }

        default:
          break;
      }

      if (method === 'DELETE' && url.pathname.startsWith('/api/secrets/')) {
        const reference = decodeURIComponent(url.pathname.slice('/api/secrets/'.length));
        const removed = await store.delete(reference);
        sendJson(response, removed ? 200 : 404, { ok: removed });
        return;
      }

      sendError(response, 404, `Unknown endpoint: ${route}`);
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(response, error.status, error.message, { kind: error.kind, hint: error.hint });
        return;
      }
      if (error instanceof ApiError) {
        sendError(response, statusForApiError(error), error.message, {
          kind: error.kind,
          hint: error.hint,
        });
        return;
      }
      if (error instanceof ToolPolicyError) {
        sendError(response, 400, error.message, { kind: 'bad_request' });
        return;
      }
      if (error instanceof FileProcessingError) {
        sendError(response, 400, error.message, { kind: 'bad_request' });
        return;
      }
      if (error instanceof McpConnectionError) {
        sendError(response, 502, error.message, { kind: 'network' });
        return;
      }
      if (error instanceof WebToolError) {
        const status = error.kind === 'blocked' || error.kind === 'invalid' ? 400 : 502;
        sendError(response, status, error.message, { kind: error.kind === 'blocked' || error.kind === 'invalid' ? 'bad_request' : 'network' });
        return;
      }
      if (error instanceof ToolExecutionError) {
        sendError(response, 400, error.message, { kind: 'bad_request' });
        return;
      }
      logger.error('API request failed', { message: error instanceof Error ? error.message : String(error) });
      sendError(response, 500, 'The proxy failed to handle the request.');
    }
  }

  async function handleChat(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request, config.maxBodyBytes);

    const baseUrl = readString(body, 'baseUrl');
    const apiKey = readOptionalString(body, 'apiKey');
    const secretRef = readOptionalString(body, 'secretRef');
    const requestedModel = readOptionalString(body, 'model') ?? '';
    const messages = readMessages(body);
    const { params } = parseInferenceParams(body.params);
    const timeoutMs = readTimeout(body);

    const target = { baseUrl, apiKey, secretRef };
    const resolved = await proxy.resolveTarget(target);

    // An empty model ID means "the first model the server reports" (the
    // documented profile default). It is resolved here instead of sending an
    // empty model upstream or failing with a technical message.
    let model = requestedModel.trim();
    if (!model) {
      const models = await proxy.listModels(target, timeoutMs);
      model = models[0] ?? '';
      if (!model) {
        throw new HttpError(
          400,
          'The endpoint reports no models. Enter the model ID of the server in the profile.',
          'not_found',
          'Run "Discover models" in the connection settings, or type the model ID by hand.',
        );
      }
    }

    const capabilities = await proxy.detectCapabilities(resolved.baseUrl, resolved.apiKey, timeoutMs, model);

    const wantsStream = params.stream === true;

    if (wantsStream && !capabilities.streamingVerified) {
      throw new HttpError(
        409,
        'Streaming has not been verified for this endpoint. Run the streaming probe first, or disable streaming.',
        'bad_request',
        'Open the Inference settings and run "Verify streaming support", or turn streaming off.',
      );
    }

    const upstreamBody = proxy.buildUpstreamBody(model, messages, params, capabilities);

    if (!wantsStream) {
      const client = proxy.createClient(resolved.baseUrl, resolved.apiKey, timeoutMs);
      const completion = await client.chatCompletion(upstreamBody);
      sendJson(response, 200, { response: completion, model: completion.model ?? model });
      return;
    }

    await streamChat(response, resolved, upstreamBody, timeoutMs);
  }

  async function streamChat(
    response: http.ServerResponse,
    resolved: { baseUrl: string; apiKey?: string },
    upstreamBody: ChatCompletionRequestBody,
    timeoutMs: number,
  ): Promise<void> {
    const controller = new AbortController();

    // A disconnect of the *client* cancels the upstream request. The `close`
    // event of the request must not be used for this: it also fires when the
    // request body was received completely.
    const stopWatching = watchForDisconnect(response, () => controller.abort());

    // A stream that never ends must not hold the connection forever.
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (resolved.apiKey) headers.Authorization = `Bearer ${resolved.apiKey}`;

    let upstream: Response;
    try {
      upstream = await proxy.pinnedFetch(joinApiPath(resolved.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...upstreamBody, stream: true }),
        signal: controller.signal,
        // Redirects are not followed: a redirect could send the prompt and
        // the key to a host that is not allowed to see them.
        redirect: 'manual',
      });
    } catch (error) {
      clearTimeout(timeout);
      stopWatching();
      if (controller.signal.aborted) {
        throw new HttpError(499, 'The client cancelled the request.');
      }
      throw new HttpError(
        502,
        `The upstream server could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!upstream.ok) {
      clearTimeout(timeout);
      stopWatching();
      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        throw new HttpError(
          502,
          'The upstream server answered the streaming request with a redirect. ' +
            'The request was not forwarded to the target of the redirect.',
        );
      }
      // The body of an error answer is untrusted server output. It must not
      // be able to echo the key into the browser response.
      const detail = await upstream.text().catch(() => '');
      const safeDetail = redactSecrets(detail.slice(0, 300), [resolved.apiKey]);
      throw new HttpError(
        upstream.status,
        `The upstream server returned HTTP ${upstream.status} for the streaming request.${
          safeDetail ? ` ${safeDetail}` : ''
        }`,
      );
    }

    if (!upstream.body) {
      clearTimeout(timeout);
      stopWatching();
      response.end();
      return;
    }

    // `stream: true` in the request is not a promise of an event stream. An
    // endpoint that ignores it would otherwise be forwarded as if it were
    // SSE, and the client would read an empty, "complete" answer.
    const upstreamType = (upstream.headers.get('content-type') ?? '').toLowerCase();
    if (!upstreamType.includes('text/event-stream')) {
      clearTimeout(timeout);
      stopWatching();
      await upstream.body.cancel().catch(() => undefined);
      throw new HttpError(
        502,
        `The endpoint answered the streaming request with "${upstreamType || 'no content type'}" instead of text/event-stream. The answer was not forwarded.`,
        'inference',
        'Disable streaming for this endpoint, or check that it really supports Server-Sent Events.',
      );
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) response.write(Buffer.from(value));
      }
    } catch (error) {
      // The stream broke. Tell the client instead of ending it silently, so a
      // failed generation is not mistaken for a complete answer.
      const aborted = controller.signal.aborted;
      logger.warn('The streaming upstream connection failed', {
        message: error instanceof Error ? error.message : String(error),
        aborted,
      });

      if (!response.writableEnded) {
        response.write(
          `data: ${JSON.stringify({
            error: {
              message: aborted
                ? 'The request was cancelled.'
                : 'The upstream connection failed while the answer was streamed.',
            },
          })}\n\n`,
        );
      }
    } finally {
      clearTimeout(timeout);
      stopWatching();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock?.();
      if (!response.writableEnded) {
        response.end();
      }
    }
  }

  return { server, config, logger, store, proxy, files, toolChat };
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `The field "${key}" is required.`);
  }
  return value;
}

function readOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readId(body: Record<string, unknown>, key: string): string {
  const value = readString(body, key).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new HttpError(400, `The field "${key}" is not a valid identifier.`);
  return value;
}

function readQueryId(url: URL, key: string): string {
  const value = url.searchParams.get(key) ?? '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new HttpError(400, `The query parameter "${key}" is required and must be a valid identifier.`);
  return value;
}

function readTarget(body: Record<string, unknown>): { baseUrl: string; apiKey?: string; secretRef?: string } {
  return {
    baseUrl: readString(body, 'baseUrl'),
    ...(readOptionalString(body, 'apiKey') ? { apiKey: readOptionalString(body, 'apiKey') } : {}),
    ...(readOptionalString(body, 'secretRef') ? { secretRef: readOptionalString(body, 'secretRef') } : {}),
  };
}

function decodeUpload(encoded: string): Buffer {
  const maximumEncodedLength = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
  if (!encoded || encoded.length > maximumEncodedLength || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new FileProcessingError('The upload payload is not valid base64 or exceeds the upload limit.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength > MAX_UPLOAD_BYTES || bytes.toString('base64') !== encoded) {
    throw new FileProcessingError('The upload payload is not canonical base64 or exceeds the 4 MiB limit.');
  }
  return bytes;
}

async function assertToolSecretsExist(
  settings: import('../shared/tools/types').ToolProfileSettings,
  store: SecretStore,
): Promise<void> {
  const references = new Set<string>();
  if (settings.web.provider === 'brave' && settings.web.secretRef) references.add(settings.web.secretRef);
  for (const tool of settings.httpTools) for (const header of tool.headers) if (header.secretRef) references.add(header.secretRef);
  for (const server of settings.mcpServers) for (const header of server.headers ?? []) if (header.secretRef) references.add(header.secretRef);
  for (const reference of references) {
    if (!await store.get(reference)) throw new HttpError(400, `A configured tool credential reference ("${reference}") is missing from the server-side secret store.`);
  }
}

async function resolveStoredHeaders(
  entries: Array<{ name: string; value?: string; secretRef?: string }>,
  store: SecretStore,
  logger: Logger,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.secretRef) {
      const secret = await store.get(entry.secretRef);
      if (!secret) throw new HttpError(400, 'A configured MCP credential is missing from the server-side secret store.');
      logger.registerSecret(secret);
      headers[entry.name] = secret;
    } else if (entry.value !== undefined) headers[entry.name] = entry.value;
  }
  return headers;
}

function readTimeout(body: Record<string, unknown>): number {
  const value = body.timeoutMs;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(value, 1_800_000);
  }
  return 120_000;
}

function readMessages(body: Record<string, unknown>): ChatMessageInput[] {
  const value = body.messages;
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, 'At least one message is required.');
  }

  const messages: ChatMessageInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const role = record.role;
    const content = record.content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string') continue;
    messages.push({ role, content });
  }

  if (messages.length === 0) {
    throw new HttpError(400, 'The message list does not contain a valid message.');
  }
  return messages;
}

function statusForApiError(error: ApiError): number {
  switch (error.kind) {
    case 'auth':
      return 502;
    case 'not_found':
      return 404;
    case 'bad_request':
      return 400;
    case 'timeout':
      return 504;
    case 'cors_or_proxy':
    case 'network':
      return 502;
    case 'server':
      return 502;
    default:
      return 500;
  }
}

function setSecurityHeaders(response: http.ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
}

async function serveStatic(
  pathname: string,
  response: http.ServerResponse,
  clientDir: string,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendError(response, 400, 'The path is not correctly encoded.');
    return;
  }

  const relative = decoded.replace(/^\/+/, '');
  const candidate = resolveWithinDirectory(clientDir, relative === '' ? 'index.html' : relative);

  if (!candidate) {
    sendError(response, 403, 'Forbidden path.');
    return;
  }

  let filePath = candidate;
  let stat = await fsp.stat(filePath).catch(() => undefined);

  if (!stat || stat.isDirectory()) {
    filePath = path.join(clientDir, 'index.html');
    stat = await fsp.stat(filePath).catch(() => undefined);
  }

  if (!stat || !stat.isFile()) {
    sendError(
      response,
      404,
      'The browser client has not been built yet. Run "npm run build" or use "npm run dev".',
    );
    return;
  }

  // Lexical containment is not enough if the client directory contains a
  // symlink that points outside it; compare canonical paths before reading.
  const [realBase, realFile] = await Promise.all([
    fsp.realpath(clientDir).catch(() => undefined),
    fsp.realpath(filePath).catch(() => undefined),
  ]);
  if (!realBase || !realFile || (realFile !== realBase && !realFile.startsWith(`${realBase}${path.sep}`))) {
    sendError(response, 403, 'Forbidden path.');
    return;
  }
  filePath = realFile;

  const extension = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream';
  const cacheable = filePath.includes(`${path.sep}assets${path.sep}`);

  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': cacheable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });

  if (response.req.method === 'HEAD') {
    response.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(response);
  });
}
