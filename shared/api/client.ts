/**
 * The single OpenAI-compatible API client.
 *
 * Both the connection test and the chat view go through this class, so the
 * request shape, the error classification and the credential handling are
 * defined exactly once.
 *
 * Credential rules enforced here:
 *  - the API key is only ever sent in the `Authorization` header
 *  - the header is only attached to requests that target the configured base
 *    URL origin
 *  - the key is never placed in a URL, a query string or an error message
 */

import { APP_USER_AGENT } from '../version';
import { ApiError, classifyHttpStatus, redactSecrets, withHint } from './errors';
import { joinApiPath, normalizeBaseUrl } from './url';
import type {
  ChatCompletionRequestBody,
  ChatCompletionResponse,
  ModelListResponse,
  OpenAIModel,
  ServerProps,
} from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenAIClientOptions {
  /** Base URL, with or without the `/v1` suffix. */
  baseUrl: string;
  /** API key. Optional: some local servers run without authentication. */
  apiKey?: string;
  /** Per request timeout in milliseconds. */
  timeoutMs?: number;
  /** Injection point for tests. */
  fetchImpl?: FetchLike;
  /**
   * Maximum number of redirects that are followed. Redirects are followed
   * manually so that every hop can be validated.
   */
  maxRedirects?: number;
  /**
   * Called with every redirect target. Returning `false` refuses the
   * redirect. A redirect to a different origin is always refused when an API
   * key is configured, so the key can never leak to another host.
   */
  validateRedirect?: (target: string) => boolean;
}

export interface RequestOptions {
  /** Caller supplied cancellation signal. */
  signal?: AbortSignal;
  /** Overrides the client timeout for a single call. */
  timeoutMs?: number;
}

export interface ListModelsResult {
  models: OpenAIModel[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Header names that must never be forwarded to an upstream host. */
const FORWARD_BLOCKED_HEADERS = new Set(['host', 'cookie', 'origin', 'referer']);

export class OpenAIClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly maxRedirects: number;
  private readonly validateRedirect?: (target: string) => boolean;

  constructor(options: OpenAIClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (options.apiKey !== undefined && options.apiKey.trim() === '') {
      throw new ApiError('auth', 'The API key is empty.');
    }
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.maxRedirects = options.maxRedirects ?? 5;
    this.validateRedirect = options.validateRedirect;
  }

  /** The base URL without the `/v1` suffix, for display purposes. */
  get rootUrl(): string {
    return this.baseUrl.replace(/\/v1$/i, '');
  }

  /** True when an API key is configured. */
  get hasApiKey(): boolean {
    return this.apiKey !== undefined;
  }

  async listModels(options: RequestOptions = {}): Promise<ListModelsResult> {
    const payload = await this.request<ModelListResponse>('/models', { method: 'GET' }, options);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return { models: data.filter((entry): entry is OpenAIModel => typeof entry?.id === 'string') };
  }

  async chatCompletion(
    body: ChatCompletionRequestBody,
    options: RequestOptions = {},
  ): Promise<ChatCompletionResponse> {
    const payload = await this.request<ChatCompletionResponse>(
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      },
      options,
    );

    if (!payload || typeof payload !== 'object') {
      throw new ApiError('invalid_response', 'The server returned an empty response body.');
    }
    return payload;
  }

  /** Best effort server metadata. Returns null when the endpoint is absent. */
  async props(options: RequestOptions = {}): Promise<ServerProps | null> {
    try {
      const payload = await this.request<ServerProps>('/props', { method: 'GET' }, options);
      return payload ?? null;
    } catch (error) {
      if (error instanceof ApiError && (error.kind === 'not_found' || error.kind === 'bad_request')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Perform a request against the configured base URL.
   *
   * All network, HTTP and decoding failures are converted into `ApiError`
   * instances with a classified `kind` and a message that never contains the
   * API key.
   */
  async request<T>(
    path: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
    options: RequestOptions = {},
  ): Promise<T> {
    const url = joinApiPath(this.baseUrl, path);
    const headers = this.buildHeaders(init.headers);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new ApiError('aborted', 'The request was cancelled before it started.');
      }
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    let currentUrl = url;
    let currentMethod = init.method;
    let currentBody = init.body;

    try {
      for (let hop = 0; ; hop += 1) {
        const hopHeaders: Record<string, string> = { ...headers };
        if (currentMethod === 'GET') delete hopHeaders['Content-Type'];

        response = await this.fetchImpl(currentUrl, {
          method: currentMethod,
          headers: hopHeaders,
          body: currentBody,
          signal: controller.signal,
          // Redirects are followed manually so that every hop is validated.
          redirect: 'manual',
        });

        const location = response.headers.get('location');
        const isRedirect = [301, 302, 303, 307, 308].includes(response.status) && Boolean(location);

        if (!isRedirect || hop >= this.maxRedirects) {
          if (isRedirect) {
            throw new ApiError(
              'bad_request',
              'The endpoint redirected too many times.',
              { hint: 'Check the base URL of the endpoint.' },
            );
          }
          break;
        }

        const target = this.resolveRedirect(currentUrl, location as string);

        if (this.apiKey && new URL(target).origin !== new URL(this.baseUrl).origin) {
          throw new ApiError(
            'bad_request',
            'The endpoint tried to redirect to a different origin. The API key is not sent to another host.',
            { hint: 'Point the profile at the final URL of the endpoint.' },
          );
        }

        if (this.validateRedirect && !this.validateRedirect(target)) {
          throw new ApiError(
            'bad_request',
            `The endpoint redirected to ${new URL(target).host}, which is not on the allow list of this proxy.`,
            { hint: 'Add the host to KAGGLE_KIT_ALLOWED_HOSTS or use a different endpoint.' },
          );
        }

        // 303 (and 301/302 for POST) turn the request into a GET.
        if (response.status === 303 || (currentMethod === 'POST' && [301, 302].includes(response.status))) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        currentUrl = target;
      }
    } catch (error) {
      if (timedOut) {
        throw new ApiError(
          'timeout',
          `The request to ${this.redact(url)} timed out after ${Math.round(timeoutMs / 1000)}s.`,
          { hint: withHint('timeout'), cause: error },
        );
      }
      if (options.signal?.aborted) {
        throw new ApiError('aborted', 'The request was cancelled.', { cause: error });
      }
      if (error instanceof ApiError) throw error;
      throw this.toNetworkError(error, currentUrl);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }

    const text = await this.readBody(response, url);

    if (!response.ok) {
      throw this.toHttpError(response.status, text, url);
    }

    if (!text.trim()) {
      throw new ApiError('invalid_response', 'The server returned an empty response body.', {
        httpStatus: response.status,
        hint: withHint('invalid_response'),
      });
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new ApiError(
        'invalid_response',
        `The server returned a response that is not valid JSON: ${this.redact(text.slice(0, 200))}`,
        { httpStatus: response.status, hint: withHint('invalid_response'), cause: error },
      );
    }
  }

  /** Resolve a redirect target against the current URL. */
  private resolveRedirect(currentUrl: string, location: string): string {
    try {
      return new URL(location, currentUrl).toString();
    } catch {
      throw new ApiError('invalid_response', 'The endpoint returned an unusable redirect target.');
    }
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': APP_USER_AGENT,
    };

    for (const [key, value] of Object.entries(extra ?? {})) {
      if (FORWARD_BLOCKED_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = value;
    }

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private async readBody(response: Response, url: string): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw new ApiError('network', `The connection to ${this.redact(url)} was interrupted.`, {
        httpStatus: response.status,
        hint: withHint('network'),
        cause: error,
      });
    }
  }

  private toHttpError(status: number, body: string, url: string): ApiError {
    const kind = classifyHttpStatus(status);
    const serverMessage = this.extractServerMessage(body);
    const detail = serverMessage ?? this.redact(body.slice(0, 500));

    let message: string;
    switch (kind) {
      case 'auth':
        message = 'The server rejected the API key (HTTP 401/403).';
        break;
      case 'not_found':
        message = `The endpoint or model was not found (HTTP 404): ${this.redact(url)}`;
        break;
      case 'bad_request':
        message = 'The server rejected the request payload (HTTP 400).';
        break;
      case 'timeout':
        message = 'The server timed out while handling the request (HTTP 408/504).';
        break;
      case 'server':
        message = `The server failed while handling the request (HTTP ${status}).`;
        break;
      default:
        message = `The request failed with HTTP ${status}.`;
    }

    if (detail) {
      message = `${message} ${detail}`;
    }

    return new ApiError(kind, this.redact(message), {
      httpStatus: status,
      detail: detail ? this.redact(detail) : undefined,
      hint: withHint(kind),
    });
  }

  private toNetworkError(error: unknown, url: string): ApiError {
    const message = error instanceof Error ? error.message : String(error);
    const looksLikeCors =
      /failed to fetch|networkerror|load failed|econnrefused|err_/i.test(message) ||
      (error instanceof TypeError && /fetch/i.test(message));

    if (looksLikeCors) {
      return new ApiError(
        'cors_or_proxy',
        `The request to ${this.redact(url)} could not be completed (${this.redact(message)}).`,
        { hint: withHint('cors_or_proxy'), cause: error },
      );
    }

    return new ApiError('network', `The request to ${this.redact(url)} failed: ${this.redact(message)}`, {
      hint: withHint('network'),
      cause: error,
    });
  }

  private extractServerMessage(body: string): string | undefined {
    if (!body) return undefined;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      if (typeof parsed.error === 'string') return parsed.error;
      if (parsed.error?.message) return parsed.error.message;
      if (parsed.message) return parsed.message;
      return undefined;
    } catch {
      return undefined;
    }
  }

  private redact(text: string): string {
    return redactSecrets(text, [this.apiKey]);
  }
}
