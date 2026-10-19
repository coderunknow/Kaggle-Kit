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

import { ApiError, redactSecrets } from '../shared/api/errors';
import { OpenAIClient } from '../shared/api/client';
import { CONNECTION_STAGE_ORDER } from '../shared/connection';
import { extractDelta, parseSseStream } from '../shared/api/stream';
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
import type {
  ConnectionStage,
  ConnectionStageResult,
  ConnectionTestResult,
} from '../shared/domain';
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
   * Run a full connection test.
   *
   * Every step is reported on its own: reachability, authentication, the
   * model list, the model itself, a real non-streaming inference and the
   * streaming probe. `ok` is only true when the real inference succeeded;
   * streaming is never implied by an HTTP 200 and stays "not run" until the
   * dedicated probe verifies it.
   */
  async testConnection(
    target: UpstreamTarget,
    options: { model?: string; timeoutMs: number },
  ): Promise<ConnectionTestResult> {
    const requestedBaseUrl = (target.baseUrl ?? '').trim();
    const { baseUrl, apiKey } = await this.resolveTarget(target);
    const normalized = normalizeBaseUrlDetailed(requestedBaseUrl);
    const baseUrlChanged = normalized.changed;
    const client = this.client(baseUrl, apiKey, options.timeoutMs);
    const stages: ConnectionStageResult[] = [];

    const finish = (
      ok: boolean,
      extra: Pick<
        ConnectionTestResult,
        'modelId' | 'capabilities' | 'errorKind' | 'errorMessage' | 'errorHint'
      > = {},
    ): ConnectionTestResult => ({
      ok,
      baseUrl,
      requestedBaseUrl,
      baseUrlChanged,
      testedAt: new Date().toISOString(),
      stages: completeStages(stages),
      ...extra,
    });

    let discovered: string[];

    try {
      const { models } = await client.listModels();
      discovered = models.map((model) => model.id);

      stages.push({
        stage: 'transport',
        status: 'ok',
        message: 'The endpoint answered the model list request.',
      });
      stages.push({
        stage: 'auth',
        status: 'ok',
        message: apiKey
          ? 'The endpoint accepted the API key.'
          : 'The endpoint accepted the request without an API key.',
      });
      stages.push({
        stage: 'models',
        status: 'ok',
        message: discovered.length
          ? `Model list retrieved (${discovered.length} model(s)).`
          : 'The endpoint answered with an empty model list.',
      });
    } catch (error) {
      const apiError = toApiError(error);
      const reachedServer = apiError.httpStatus !== undefined;

      if (!reachedServer) {
        stages.push({
          stage: 'transport',
          status: 'failed',
          message: apiError.message,
        });
        return finish(false, {
          errorKind: apiError.kind,
          errorMessage: apiError.message,
          ...(apiError.hint ? { errorHint: apiError.hint } : {}),
        });
      }

      stages.push({
        stage: 'transport',
        status: 'ok',
        message: `The endpoint answered with HTTP ${apiError.httpStatus}.`,
        ...(apiError.httpStatus !== undefined ? { httpStatus: apiError.httpStatus } : {}),
      });

      if (apiError.kind === 'auth') {
        stages.push({
          stage: 'auth',
          status: 'failed',
          message: apiError.message,
          ...(apiError.httpStatus !== undefined ? { httpStatus: apiError.httpStatus } : {}),
        });
      } else {
        stages.push({
          stage: 'auth',
          status: 'not_run',
          message: `Authentication could not be verified because the model list request ended with HTTP ${apiError.httpStatus}.`,
        });
      }

      stages.push({
        stage: 'models',
        status: 'failed',
        message: apiError.message,
        ...(apiError.httpStatus !== undefined ? { httpStatus: apiError.httpStatus } : {}),
      });

      return finish(false, {
        ...(options.model?.trim() ? { modelId: options.model.trim() } : {}),
        errorKind: apiError.kind,
        errorMessage: apiError.message,
        ...(apiError.hint ? { errorHint: apiError.hint } : {}),
      });
    }

    let modelId = options.model?.trim() || '';
    let modelWasAdvertised = false;

    if (!modelId) {
      modelId = discovered[0] ?? '';
      if (modelId) {
        modelWasAdvertised = true;
        stages.push({
          stage: 'model',
          status: 'ok',
          message: `No model was configured; the first model reported by the endpoint is used: ${modelId}.`,
        });
      }
    } else if (discovered.includes(modelId)) {
      modelWasAdvertised = true;
      stages.push({
        stage: 'model',
        status: 'ok',
        message: `The endpoint advertises the configured model ${modelId}.`,
      });
    } else if (discovered.length > 0) {
      stages.push({
        stage: 'model',
        status: 'warning',
        message: `"${modelId}" is not in the model list (${discovered.join(', ')}). The inference request decides whether it is usable.`,
      });
    } else {
      stages.push({
        stage: 'model',
        status: 'warning',
        message: `The endpoint reported no models. The inference request decides whether "${modelId}" is usable.`,
      });
    }

    if (!modelId) {
      stages.push({
        stage: 'model',
        status: 'failed',
        message: 'No model ID is available. The endpoint reported no models and no model was configured.',
      });
      return finish(false, {
        errorKind: 'not_found',
        errorMessage: 'No model ID is available for the inference test.',
        errorHint:
          'The endpoint reported no models. Enter the model ID of the server in the profile and test again.',
      });
    }

    try {
      const response = await client.chatCompletion({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 24,
        temperature: 0,
        stream: false,
      });

      const choice = response.choices?.[0];
      if (!Array.isArray(response.choices) || response.choices.length === 0) {
        throw new ApiError('inference', 'The server accepted the request but returned no choices.');
      }
      if (!choice?.message) {
        throw new ApiError(
          'invalid_response',
          'The server returned a completion without an assistant message.',
        );
      }

      const content = choice.message.content ?? '';
      const reasoning =
        choice.message.reasoning_content ?? choice.message.reasoning ?? '';
      if (!content.trim() && !reasoning.trim()) {
        throw new ApiError(
          'inference',
          'The server returned an empty completion for the inference test.',
        );
      }

      stages.push({
        stage: 'inference',
        status: 'ok',
        message: 'A real chat completion was returned by the server.',
      });

      // An alias that the model list did not advertise is confirmed by the
      // inference itself. It is a working configuration, not a warning.
      if (!modelWasAdvertised) {
        const index = stages.findIndex((entry) => entry.stage === 'model');
        if (index !== -1) {
          stages[index] = {
            stage: 'model',
            status: 'ok',
            message: `The model ${modelId} answered an inference request. It is not advertised in /v1/models (an alias is possible).`,
          };
        }
      }
    } catch (error) {
      const apiError = toApiError(error);
      stages.push({
        stage: 'inference',
        status: 'failed',
        message: apiError.message,
        ...(apiError.httpStatus !== undefined ? { httpStatus: apiError.httpStatus } : {}),
      });
      return finish(false, {
        modelId,
        errorKind: apiError.kind,
        errorMessage: apiError.message,
        ...(apiError.hint ? { errorHint: apiError.hint } : {}),
      });
    }

    const capabilities = await this.detectCapabilities(baseUrl, apiKey, options.timeoutMs);
    stages.push({
      stage: 'streaming',
      status: capabilities.streamingVerified ? 'ok' : 'not_run',
      message: capabilities.streamingVerified
        ? 'Streaming was verified for this endpoint and credential earlier in this session.'
        : 'Not tested. Run "Verify streaming support" to check Server-Sent Events separately.',
    });

    return finish(true, { modelId, capabilities });
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

      // An HTTP 200 with a text/event-stream header is not enough: the
      // events have to be readable, they have to carry answer text and the
      // stream has to end with [DONE] or a finish reason. A keep-alive
      // comment or a truncated stream must not verify streaming.
      let characters = 0;
      let finished = false;
      let streamError: string | undefined;
      let events = 0;

      try {
        for await (const event of parseSseStream(response.body, controller.signal)) {
          events += 1;
          if (events > 500) {
            streamError = 'The event stream did not finish within 500 events.';
            break;
          }

          const delta = extractDelta(event);
          if (delta.error) {
            streamError = delta.error;
            break;
          }
          if (delta.content) characters += delta.content.length;
          if (delta.reasoning) characters += delta.reasoning.length;
          if (delta.finishReason) {
            finished = true;
            break;
          }
        }
      } catch (error) {
        streamError = controller.signal.aborted
          ? 'The streaming probe timed out before the answer was complete.'
          : toApiError(error).message;
      }

      if (streamError) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now() });
        return { supported: false, detail: redactSecrets(streamError, [apiKey]) };
      }

      if (characters === 0) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now() });
        return {
          supported: false,
          detail: 'The event stream contained no answer text (keep-alive comments and empty deltas are not enough).',
        };
      }

      if (!finished) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now() });
        return {
          supported: false,
          detail:
            'The event stream ended without [DONE] or a finish reason; the answer may be truncated.',
        };
      }

      this.storeCapability(key, { streamingVerified: true, streamingCheckedAt: Date.now() });
      return {
        supported: true,
        detail: `The endpoint delivered ${characters} character(s) of a text/event-stream answer and ended it with a finish marker.`,
      };
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

/**
 * Fill in every stage that the test did not reach, in the canonical order.
 * The UI can therefore render the same six steps for every result.
 */
const STAGE_NOT_CHECKED: Record<ConnectionStage, string> = {
  transport: 'The endpoint was not reached.',
  auth: 'Not checked because the endpoint was not reached.',
  models: 'Not checked because no model list was available.',
  model: 'Not checked because no usable model was found.',
  inference: 'Not checked because no usable model was found.',
  streaming: 'Not tested. Run "Verify streaming support" to check Server-Sent Events separately.',
};

function completeStages(stages: ConnectionStageResult[]): ConnectionStageResult[] {
  const byStage = new Map(stages.map((stage) => [stage.stage, stage]));
  return CONNECTION_STAGE_ORDER.map(
    (stage): ConnectionStageResult =>
      byStage.get(stage) ?? {
        stage,
        status: 'not_run',
        message: STAGE_NOT_CHECKED[stage],
      },
  );
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
