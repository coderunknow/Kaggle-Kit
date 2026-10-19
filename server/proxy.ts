/**
 * Upstream (llama.cpp / OpenAI-compatible) access layer.
 *
 * The backend is the only component that talks to the model server. It does
 * that for two reasons:
 *
 *  1. it removes the CORS problem entirely - the browser only ever calls this
 *     backend, which runs on the same origin,
 *  2. it keeps the API key out of the browser whenever the user chooses the
 *     "server" credential mode.
 *
 * Streaming is never assumed: the backend verifies that the configured
 * endpoint really delivers `text/event-stream` before it proxies a streaming
 * request.
 */

import { createHash } from 'node:crypto';

import { ApiError } from '../shared/api/errors';
import { OpenAIClient } from '../shared/api/client';
import { buildChatCompletionBody } from '../shared/api/requests';
import type { InferenceParams, ServerCapabilities } from '../shared/api/requests';
import { joinApiPath, normalizeBaseUrlDetailed, UrlValidationError } from '../shared/api/url';
import { assertDestinationAllowed } from './destinations';
import type {
  ChatCompletionRequestBody,
  ChatCompletionResponse,
  ChatMessageInput,
  ServerProps,
} from '../shared/api/types';
import type { ConnectionStageResult, ConnectionTestResult } from '../shared/domain';
import type { ServerConfig } from './config';
import type { Logger } from './logger';
import type { SecretStore } from './secrets';

export interface UpstreamTarget {
  baseUrl: string;
  /** Key supplied by the browser (session or browser credential mode). */
  apiKey?: string;
  /** Reference into the server side secret store. */
  secretRef?: string;
}

interface CapabilityCacheEntry {
  streamingVerified: boolean;
  streamingCheckedAt: number;
  reasoningEffortSupported: boolean;
  propsCheckedAt: number;
}

const STREAM_PROBE_TTL_MS = 10 * 60 * 1000;

export class ProxyService {
  private readonly capabilities = new Map<string, CapabilityCacheEntry>();
  /**
   * Capabilities belong to an endpoint *and* a credential. A server started
   * with a rotated key can answer differently, and a streaming probe is only
   * meaningful for the key it was made with. The key itself is never part of
   * the cache: only its SHA-256 hash is.
   */
  private static readonly CAPABILITY_CACHE_LIMIT = 32;

  private capabilityKey(baseUrl: string, apiKey: string | undefined): string {
    const digest = apiKey ? createHash('sha256').update(apiKey).digest('hex') : '';
    return `${baseUrl}\u0000${digest}`;
  }

  constructor(
    private readonly config: ServerConfig,
    private readonly store: SecretStore,
    private readonly logger: Logger,
  ) {}

  /** Normalize and validate an incoming target. */
  async resolveTarget(target: UpstreamTarget): Promise<{ baseUrl: string; apiKey?: string }> {
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrlDetailed(target.baseUrl ?? '').baseUrl;
    } catch (error) {
      if (error instanceof UrlValidationError) {
        throw new ApiError('bad_request', error.message, { hint: 'Fix the base URL in the profile.' });
      }
      throw error;
    }

    assertDestinationAllowed(baseUrl, {
      allowedHosts: this.config.allowedHosts,
      blockPrivateNetworks: this.config.blockPrivateNetworks,
    });

    let apiKey = target.apiKey?.trim() || undefined;
    if (!apiKey && target.secretRef) {
      apiKey = (await this.store.get(target.secretRef)) ?? undefined;
    }

    if (apiKey) this.logger.registerSecret(apiKey);
    return { baseUrl, apiKey };
  }

  /** Every redirect target has to pass the same policy as the first URL. */
  private isRedirectAllowed(target: string): boolean {
    try {
      assertDestinationAllowed(target, {
        allowedHosts: this.config.allowedHosts,
        blockPrivateNetworks: this.config.blockPrivateNetworks,
      });
      return true;
    } catch {
      return false;
    }
  }

  private client(baseUrl: string, apiKey: string | undefined, timeoutMs: number): OpenAIClient {
    return new OpenAIClient({
      baseUrl,
      apiKey,
      timeoutMs,
      validateRedirect: (target) => this.isRedirectAllowed(target),
    });
  }

  /** List the models exposed by the endpoint. */
  async listModels(target: UpstreamTarget, timeoutMs: number): Promise<string[]> {
    const { baseUrl, apiKey } = await this.resolveTarget(target);
    const client = this.client(baseUrl, apiKey, timeoutMs);
    const { models } = await client.listModels();
    return models.map((model) => model.id);
  }

  /**
   * Run a full connection test: model discovery followed by a real inference
   * request. Every stage is reported separately so the UI can show what
   * worked and what did not.
   */
  async testConnection(
    target: UpstreamTarget,
    options: { model?: string; timeoutMs: number },
  ): Promise<ConnectionTestResult> {
    const { baseUrl, apiKey } = await this.resolveTarget(target);
    const client = this.client(baseUrl, apiKey, options.timeoutMs);
    const stages: ConnectionStageResult[] = [];

    let modelId = options.model?.trim() || '';
    const discovered: string[] = [];

    try {
      const { models } = await client.listModels();
      discovered.push(...models.map((model) => model.id));

      if (modelId && discovered.length > 0 && !discovered.includes(modelId)) {
        stages.push({
          stage: 'models',
          status: 'warning',
          message: `The server is reachable, but "${modelId}" is not in the model list (${discovered.join(', ')}).`,
        });
      } else {
        stages.push({
          stage: 'models',
          status: 'ok',
          message: discovered.length
            ? `Model list retrieved (${discovered.length} model(s)).`
            : 'The server answered the model list request.',
        });
      }

      if (!modelId) {
        modelId = discovered[0] ?? '';
      }
    } catch (error) {
      const apiError = toApiError(error);
      stages.push({
        stage: 'models',
        status: 'failed',
        message: apiError.message,
        ...(apiError.httpStatus ? { httpStatus: apiError.httpStatus } : {}),
      });

      return {
        ok: false,
        baseUrl,
        ...(modelId ? { modelId } : {}),
        stages,
        errorKind: apiError.kind,
        errorMessage: apiError.message,
        ...(apiError.hint ? { errorHint: apiError.hint } : {}),
      };
    }

    if (!modelId) {
      stages.push({
        stage: 'inference',
        status: 'skipped',
        message: 'No model ID is known. Pick a model in the profile and test again.',
      });
      return {
        ok: false,
        baseUrl,
        stages,
        errorKind: 'not_found',
        errorMessage: 'No model ID is available for the inference test.',
      };
    }

    try {
      const response = await client.chatCompletion({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 24,
        temperature: 0,
        stream: false,
      });

      if (!response.choices || response.choices.length === 0) {
        throw new ApiError('inference', 'The server accepted the request but returned no choices.');
      }

      stages.push({
        stage: 'inference',
        status: 'ok',
        message: 'A real chat completion was returned by the server.',
      });
    } catch (error) {
      const apiError = toApiError(error);
      stages.push({
        stage: 'inference',
        status: 'failed',
        message: apiError.message,
        ...(apiError.httpStatus ? { httpStatus: apiError.httpStatus } : {}),
      });

      return {
        ok: false,
        baseUrl,
        modelId,
        stages,
        errorKind: apiError.kind,
        errorMessage: apiError.message,
        ...(apiError.hint ? { errorHint: apiError.hint } : {}),
      };
    }

    const capabilities = await this.detectCapabilities(baseUrl, apiKey, options.timeoutMs);

    return { ok: true, baseUrl, modelId, stages, capabilities };
  }

  /** Detect optional server capabilities. Failures are not fatal. */
  async detectCapabilities(
    baseUrl: string,
    apiKey: string | undefined,
    timeoutMs: number,
  ): Promise<ServerCapabilities> {
    const key = this.capabilityKey(baseUrl, apiKey);
    const cached = this.capabilities.get(key);
    const now = Date.now();

    if (cached && now - cached.propsCheckedAt < STREAM_PROBE_TTL_MS) {
      return {
        streamingVerified: cached.streamingVerified,
        reasoningEffortSupported: cached.reasoningEffortSupported,
        notes: [],
      };
    }

    let reasoningEffortSupported = false;
    const notes: string[] = [];

    try {
      const client = this.client(baseUrl, apiKey, Math.min(timeoutMs, 20_000));
      const props = await client.props();
      if (props) {
        reasoningEffortSupported = propsMentionReasoningEffort(props);
        if (!reasoningEffortSupported) {
          notes.push(
            'The server did not advertise a per-request reasoning_effort option. Reasoning effort stays a server startup setting.',
          );
        }
      } else {
        notes.push('The server does not expose /props, so optional capabilities could not be detected.');
      }
    } catch (error) {
      notes.push(`Capability detection failed: ${toApiError(error).message}`);
    }

    this.storeCapability(key, {
      streamingVerified: cached?.streamingVerified ?? false,
      streamingCheckedAt: cached?.streamingCheckedAt ?? 0,
      reasoningEffortSupported,
      propsCheckedAt: now,
    });

    return { streamingVerified: cached?.streamingVerified ?? false, reasoningEffortSupported, notes };
  }

  /**
   * Verify that the endpoint really delivers Server-Sent Events. The result is
   * cached per base URL.
   */
  async probeStreaming(
    target: UpstreamTarget,
    options: { model?: string; timeoutMs: number },
  ): Promise<{ supported: boolean; detail: string }> {
    const { baseUrl, apiKey } = await this.resolveTarget(target);
    const key = this.capabilityKey(baseUrl, apiKey);
    const cached = this.capabilities.get(key);

    if (cached?.streamingVerified) {
      return { supported: true, detail: 'Streaming was verified for this endpoint earlier.' };
    }

    const model = options.model?.trim() || '';
    if (!model) {
      return { supported: false, detail: 'A model ID is required to probe streaming.' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs, 30_000));

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const response = await fetch(joinApiPath(baseUrl, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: 8,
          temperature: 0,
          stream: true,
        }),
        signal: controller.signal,
        // Redirects are not followed: a redirect could leave the allowed
        // destinations and the probe would then report a false positive.
        redirect: 'manual',
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now() });
        return {
          supported: false,
          detail: `The endpoint answered the streaming probe with a redirect (HTTP ${response.status}).`,
        };
      }

      if (!response.ok) {
        const detail = `The streaming probe returned HTTP ${response.status}.`;
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now() });
        return { supported: false, detail };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('text/event-stream')) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now() });
        return {
          supported: false,
          detail: `The endpoint answered with content type "${contentType || 'unknown'}" instead of text/event-stream.`,
        };
      }

      if (!response.body) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now() });
        return { supported: false, detail: 'The endpoint returned no response body.' };
      }

      const reader = response.body.getReader();
      const first = await reader.read();
      await reader.cancel().catch(() => undefined);

      if (first.done || !first.value) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now() });
        return { supported: false, detail: 'The event stream closed before any data arrived.' };
      }

      this.storeCapability(key, { streamingVerified: true, streamingCheckedAt: Date.now() });
      return { supported: true, detail: 'The endpoint delivered a text/event-stream response.' };
    } catch (error) {
      const apiError = toApiError(error);
      this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now() });
      return { supported: false, detail: apiError.message };
    } finally {
      clearTimeout(timer);
    }
  }

  private storeCapability(key: string, update: Partial<CapabilityCacheEntry>): void {
    const current = this.capabilities.get(key) ?? {
      streamingVerified: false,
      streamingCheckedAt: 0,
      reasoningEffortSupported: false,
      propsCheckedAt: 0,
    };
    // Bounded cache: an editor can change the key many times in one session.
    if (this.capabilities.size >= ProxyService.CAPABILITY_CACHE_LIMIT && !this.capabilities.has(key)) {
      const oldest = this.capabilities.keys().next().value;
      if (oldest !== undefined) this.capabilities.delete(oldest);
    }
    this.capabilities.set(key, { ...current, ...update });
  }

  /** Build the upstream request body from the client's request. */
  buildUpstreamBody(
    model: string,
    messages: ChatMessageInput[],
    params: InferenceParams,
    capabilities: ServerCapabilities,
  ): ChatCompletionRequestBody {
    const { body } = buildChatCompletionBody({ model, messages, params, capabilities });
    return body;
  }
}

function propsMentionReasoningEffort(props: ServerProps): boolean {
  if ('reasoning_effort' in props) return true;
  const defaults = props.default_generation_settings;
  if (defaults && typeof defaults === 'object' && 'reasoning_effort' in defaults) return true;
  return false;
}

/** Normalize any thrown value into an ApiError. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    return new ApiError('unknown', error.message, { cause: error });
  }
  return new ApiError('unknown', String(error));
}

export type { ChatCompletionResponse };
