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
import { extractDelta, parseSseStream, ToolCallAccumulator } from '../shared/api/stream';
import { buildChatCompletionBody } from '../shared/api/requests';
import type { InferenceParams, ReasoningPolicy, ServerCapabilities, StreamingEvidence } from '../shared/api/requests';
import { findCatalogEntryByModelId } from '../shared/model-catalog/catalog';
import { neutralizeToolClaimsForOrdinaryChat } from '../shared/prompts/qwen';
import type { ToolCallingCapability } from '../shared/tools/types';
import { joinApiPath, normalizeBaseUrlDetailed, UrlValidationError } from '../shared/api/url';
import { assertDestinationAllowed } from './destinations';
import { createPinnedFetch } from './pinnedFetch';
import type { FetchLike } from '../shared/api/client';
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
  /** What the last successful probe observed; cleared by a failed probe. */
  streamingEvidence?: StreamingEvidence;
  reasoningEffortSupported: boolean;
  templateReasoningEffortSupported: boolean;
  propsCheckedAt: number;
}

const STREAM_PROBE_TTL_MS = 10 * 60 * 1000;
const TOOL_PROBE_TTL_MS = 10 * 60 * 1000;
const MAX_TOOL_PROBE_RESPONSE_BYTES = 16_384;
/**
 * Non-streaming upstream responses are buffered in memory, so a compromised
 * or broken endpoint must not be able to stream gigabytes into the proxy
 * while the (up to 30 minute) request timeout runs. 8 MiB is far above any
 * legitimate completion (max_tokens is hard-capped at 32,768 tokens) while
 * bounding the worst case of a misbehaving endpoint.
 */
const MAX_CHAT_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ProxyService {
  private readonly capabilities = new Map<string, CapabilityCacheEntry>();
  private readonly toolCallingCapabilities = new Map<string, { capability: ToolCallingCapability; expiresAt: number }>();
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

  /**
   * Every upstream connection is pinned to a policy-validated DNS answer
   * (see pinnedFetch.ts), so a hostname that rebinds between the policy
   * check and the socket connect cannot reach loopback or metadata
   * addresses it was not configured as.
   */
  readonly pinnedFetch: FetchLike;

  constructor(
    private readonly config: ServerConfig,
    private readonly store: SecretStore,
    private readonly logger: Logger,
    /** Test seam only: production code must use the DNS-pinned fetch. */
    fetchOverride?: FetchLike,
  ) {
    this.pinnedFetch = fetchOverride ?? createPinnedFetch({
      allowedHosts: config.allowedHosts,
      blockPrivateNetworks: config.blockPrivateNetworks,
    });
  }

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

  /**
   * The one way server code may build an upstream client: DNS-pinned
   * connections plus the redirect destination policy are always attached,
   * so no call site can accidentally fall back to an unpinned fetch or
   * follow a redirect to a host outside the allow list.
   */
  createClient(baseUrl: string, apiKey: string | undefined, timeoutMs: number, maxResponseBytes?: number): OpenAIClient {
    return this.client(baseUrl, apiKey, timeoutMs, maxResponseBytes);
  }

  private client(baseUrl: string, apiKey: string | undefined, timeoutMs: number, maxResponseBytes?: number): OpenAIClient {
    return new OpenAIClient({
      baseUrl,
      apiKey,
      timeoutMs,
      fetchImpl: this.pinnedFetch,
      // Callers may tighten the limit (the capability probe uses 16 KiB);
      // they may never remove or raise it. The Math.min enforces the hard
      // maximum at this single factory instead of trusting every caller:
      // a value above it (up to Number.MAX_SAFE_INTEGER) would otherwise
      // disable the cap silently.
      maxResponseBytes: Math.min(maxResponseBytes ?? MAX_CHAT_RESPONSE_BYTES, MAX_CHAT_RESPONSE_BYTES),
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

    const capabilities = await this.detectCapabilities(baseUrl, apiKey, options.timeoutMs, modelId);
    const streamingEvidence = capabilities.streamingEvidence;
    stages.push({
      stage: 'streaming',
      status: capabilities.streamingVerified ? 'ok' : 'not_run',
      message: capabilities.streamingVerified
        ? streamingEvidence
          ? `Streaming was verified earlier in this server session (probe at ${streamingEvidence.verifiedAt}): ${streamingEvidence.contentEvents} content event(s), first after ${streamingEvidence.firstContentMs} ms. This is a capability result, not a step of this connection test.`
          : 'Streaming was verified for this endpoint and credential earlier in this session. This is a capability result, not a step of this connection test.'
        : 'Not tested. Run "Verify streaming support" to check Server-Sent Events separately.',
    });

    return finish(true, { modelId, capabilities });
  }

  /**
   * Harmless, model-specific native tool-call probe. The probe only inspects
   * the response; it never dispatches or executes the returned function.
   */
  async probeToolCalling(
    target: UpstreamTarget,
    options: { model?: string; timeoutMs: number; force?: boolean },
  ): Promise<ToolCallingCapability> {
    let model = options.model?.trim() ?? '';
    if (!model) {
      // The same "first model the server reports" contract ordinary chat
      // uses. Discovery failures and empty lists are reported honestly;
      // a model is never invented and success is never simulated.
      try {
        const discovered = await this.listModels(target, options.timeoutMs);
        model = discovered[0]?.trim() ?? '';
      } catch (error) {
        return {
          status: 'not_verified',
          detail: `No model ID is configured and the automatic discovery at /v1/models failed: ${toApiError(error).message}`,
        };
      }
      if (!model) {
        return {
          status: 'not_verified',
          detail: 'No model ID is configured and the endpoint reported no models to discover. Enter the model ID of the server in the profile, then run the probe again.',
        };
      }
    }
    if (model.length > 256) {
      return { status: 'not_verified', detail: 'A valid model ID is required for the isolated tool-calling probe.' };
    }
    const { baseUrl, apiKey } = await this.resolveTarget(target);
    const key = `${this.capabilityKey(baseUrl, apiKey)}\u0000${model}`;
    const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 20);
    const cached = this.toolCallingCapabilities.get(key);
    if (!options.force && cached && cached.expiresAt > Date.now()) return { ...cached.capability };

    const capability: ToolCallingCapability = {
      status: 'failed_verification',
      model,
      protocolVerified: false,
      roundTripVerified: false,
      configurationFingerprint: fingerprint,
      checkedAt: new Date().toISOString(),
      detail: 'The endpoint did not return the expected harmless tool-call response. Tools remain disabled.',
    };
    const probeTimeoutMs = Math.max(1, Math.min(options.timeoutMs, 30_000));
    const deadline = Date.now() + probeTimeoutMs;
    const client = this.client(baseUrl, apiKey, probeTimeoutMs, MAX_TOOL_PROBE_RESPONSE_BYTES);
    const probeMessages: ChatMessageInput[] = [
      {
        role: 'system',
        content: 'This is an isolated no-op capability probe. Never perform external actions. Call the named function exactly once with an empty object. After receiving the synthetic tool result, do not call a function again; reply with exactly KAGGLE_KIT_TOOL_PROBE_OK.',
      },
      {
        role: 'user',
        content: 'Call the function named kaggle_kit_capability_probe exactly once with an empty JSON object. The function is harmless and will not be executed.',
      },
    ];
    const probeTools = [{
      type: 'function' as const,
      function: {
        name: 'kaggle_kit_capability_probe',
        description: 'Harmless capability check. It has no side effects and must never be executed.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    }];
    let probeStage = 'initial function-call turn';
    try {
      const response = await client.chatCompletion({
        model,
        messages: probeMessages,
        tools: probeTools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        // 192 instead of 64: models that emit a brief reasoning header before
        // the function call were truncated with finish_reason="length" and
        // failed the probe although they support native tool calling.
        max_tokens: 192,
        temperature: 0,
        stream: false,
      }, { timeoutMs: Math.max(1, deadline - Date.now()) });
      const firstChoice = response.choices?.length === 1 ? response.choices[0] : undefined;
      const calls = firstChoice?.message?.tool_calls;
      const call = Array.isArray(calls) && calls.length === 1 ? calls[0] : undefined;
      let validArguments = false;
      if (call?.function?.name === 'kaggle_kit_capability_probe' && typeof call.function.arguments === 'string' && Buffer.byteLength(call.function.arguments) <= 256) {
        try {
          const parsed = JSON.parse(call.function.arguments) as unknown;
          validArguments = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
        } catch { /* invalid model output is a failed probe */ }
      }
      const validCall = firstChoice?.finish_reason === 'tool_calls' && call?.type === 'function' &&
        typeof call.id === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(call.id) && validArguments;
      if (!validCall || !call) {
        capability.status = 'failed_verification';
        capability.detail = firstChoice?.finish_reason === 'length'
          ? 'The initial probe hit max_tokens (finish_reason=length) before emitting a valid function call with finish_reason=tool_calls. Tool use remains disabled; ordinary chat is unchanged.'
          : 'The initial probe did not return exactly one valid function call with finish_reason=tool_calls. Tool use remains disabled; ordinary chat is unchanged.';
      } else {
        capability.protocolVerified = true;
        probeStage = 'synthetic tool-result follow-up';
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ApiError('timeout', 'The capability probe timed out before its synthetic follow-up.');
        const safeCall = {
          id: call.id,
          type: 'function' as const,
          function: { name: 'kaggle_kit_capability_probe', arguments: '{}' },
        };
        const followUp = await client.chatCompletion({
          model,
          messages: [
            ...probeMessages,
            { role: 'assistant', content: null, tool_calls: [safeCall] },
            { role: 'tool', tool_call_id: safeCall.id, name: 'kaggle_kit_capability_probe', content: '{"ok":true,"result":"synthetic-no-op"}' },
          ],
          tools: probeTools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
          max_tokens: 192,
          temperature: 0,
          stream: false,
        }, { timeoutMs: Math.max(1, remaining) });
        const finalChoice = followUp.choices?.length === 1 ? followUp.choices[0] : undefined;
        const finalMessage = finalChoice?.message;
        const noAdditionalCalls = finalMessage?.tool_calls === undefined ||
          (Array.isArray(finalMessage.tool_calls) && finalMessage.tool_calls.length === 0);
        const finalText = typeof finalMessage?.content === 'string' ? finalMessage.content.trim() : '';
        // The acknowledgement token must appear verbatim with word
        // boundaries; a longer word containing it (e.g.
        // "KAGGLE_KIT_TOOL_PROBE_OKAY") does not pass. The structural
        // conditions (final stop, no further calls) are unchanged.
        if (finalChoice?.finish_reason === 'stop' && noAdditionalCalls &&
          /\bKAGGLE_KIT_TOOL_PROBE_OK\b/.test(finalText)) {
          capability.status = 'supported_verified';
          capability.roundTripVerified = true;
          // Non-streaming support is proven. Streaming tool-call deltas are a
          // separate wire behaviour: verify them independently and report the
          // outcome without downgrading the proven non-streaming result.
          probeStage = 'streamed function-call turn';
          capability.streamingSupported = await this.probeStreamingToolCall(
            baseUrl, apiKey, model, probeMessages, probeTools, deadline,
          );
          capability.detail = capability.streamingSupported
            ? 'The endpoint completed an isolated two-step native tool round trip: one valid function call (finish_reason=tool_calls), then an accepted synthetic tool result and a final stop response. Streamed tool-call fragments were also assembled successfully. The function was never executed.'
            : 'The endpoint completed an isolated two-step native tool round trip: one valid function call (finish_reason=tool_calls), then an accepted synthetic tool result and a final stop response. The function was never executed. Streamed tool-call fragments were not verified; tool rounds use non-streaming requests.';
        } else {
          capability.status = 'failed_verification';
          capability.detail = finalChoice?.finish_reason === 'length'
            ? 'The endpoint did not accept and complete the synthetic tool-result follow-up before hitting max_tokens (finish_reason=length). Tool use remains disabled; ordinary chat is unchanged.'
            : 'The endpoint did not accept and complete the synthetic tool-result follow-up with a final stop response. Tool use remains disabled; ordinary chat is unchanged.';
        }
      }
    } catch (error) {
      const apiError = toApiError(error);
      capability.status = apiError.httpStatus === 400 || apiError.httpStatus === 404 || apiError.httpStatus === 422
        ? 'unsupported'
        : 'temporarily_unavailable';
      capability.detail = apiError.httpStatus === 400 || apiError.httpStatus === 404 || apiError.httpStatus === 422
        ? `The endpoint rejected the ${probeStage} (HTTP ${apiError.httpStatus}). Tool use remains disabled; ordinary chat is unchanged.`
        : `The ${probeStage} could not be completed: ${apiError.message}`;
    }
    this.toolCallingCapabilities.delete(key);
    this.toolCallingCapabilities.set(key, { capability: { ...capability }, expiresAt: Date.now() + TOOL_PROBE_TTL_MS });
    while (this.toolCallingCapabilities.size > ProxyService.CAPABILITY_CACHE_LIMIT) {
      const oldest = this.toolCallingCapabilities.keys().next().value;
      if (oldest === undefined) break;
      this.toolCallingCapabilities.delete(oldest);
    }
    return capability;
  }

  /**
   * Verify streamed tool-call fragments with the same harmless no-op function.
   * Any failure returns false; it never downgrades the non-streaming result
   * and never executes the returned call.
   */
  private async probeStreamingToolCall(
    baseUrl: string,
    apiKey: string | undefined,
    model: string,
    messages: ChatMessageInput[],
    tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
    deadline: number,
  ): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, 30_000));
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await this.pinnedFetch(joinApiPath(baseUrl, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
          // Same truncation guard as the non-streaming probe turns.
          max_tokens: 192,
          temperature: 0,
          stream: true,
        }),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok || !response.body) return false;
      if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) return false;
      const accumulator = new ToolCallAccumulator(1, 1_024);
      let events = 0;
      for await (const event of parseSseStream(response.body, controller.signal)) {
        events += 1;
        if (events > 500) return false;
        const delta = extractDelta(event);
        if (delta.error) return false;
        accumulator.add(delta);
        if (delta.finishReason) break;
      }
      const assembled = accumulator.finish();
      if (!assembled.announced || assembled.overflow || assembled.calls.length !== 1) return false;
      const call = assembled.calls[0]!;
      if (call.function.name !== 'kaggle_kit_capability_probe') return false;
      try {
        const parsed = JSON.parse(call.function.arguments) as unknown;
        return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
      } catch {
        return false;
      }
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Return only an explicit, still-fresh probe result; never infer support. */
  async getToolCallingCapability(target: UpstreamTarget, model: string): Promise<ToolCallingCapability> {
    const { baseUrl, apiKey } = await this.resolveTarget(target);
    const key = `${this.capabilityKey(baseUrl, apiKey)}\u0000${model.trim()}`;
    const cached = this.toolCallingCapabilities.get(key);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.capability };
    const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 20);
    return {
      status: 'not_verified',
      model: model.trim(),
      configurationFingerprint: fingerprint,
      detail: 'Native tool calling has not been verified for this exact endpoint, credential, and model. Run the isolated probe before enabling tools.',
    };
  }

  /** Detect optional server capabilities. Failures are not fatal. */
  async detectCapabilities(
    baseUrl: string,
    apiKey: string | undefined,
    timeoutMs: number,
    model?: string,
  ): Promise<ServerCapabilities> {
    const key = this.capabilityKey(baseUrl, apiKey);
    const cached = this.capabilities.get(key);
    const now = Date.now();
    // A still-fresh, explicit tool-probe result for exactly this endpoint,
    // credential and model survives a streaming/props re-detection. Only a
    // fresh exact-key result is attached — never a stale one and never an
    // inferred one, so re-detection neither wipes nor fabricates verification.
    const cachedTool = model?.trim()
      ? this.toolCallingCapabilities.get(`${key}\u0000${model.trim()}`)
      : undefined;
    const validToolCapability = cachedTool && cachedTool.expiresAt > now
      ? { ...cachedTool.capability }
      : undefined;

    if (cached && now - cached.propsCheckedAt < STREAM_PROBE_TTL_MS) {
      return {
        streamingVerified: cached.streamingVerified,
        ...(cached.streamingEvidence ? { streamingEvidence: cached.streamingEvidence } : {}),
        reasoningEffortSupported: cached.reasoningEffortSupported,
        templateReasoningEffortSupported: cached.templateReasoningEffortSupported,
        notes: [],
        ...(validToolCapability ? { toolCalling: validToolCapability } : {}),
      };
    }

    let reasoningEffortSupported = false;
    let templateReasoningEffortSupported = false;
    const notes: string[] = [];

    try {
      const client = this.client(baseUrl, apiKey, Math.min(timeoutMs, 20_000));
      const props = await client.props();
      if (props) {
        reasoningEffortSupported = propsMentionReasoningEffort(props);
        templateReasoningEffortSupported = propsReportTemplateReasoningEffort(props);
        if (!reasoningEffortSupported) {
          notes.push(
            'The server did not advertise a per-request reasoning_effort option. Reasoning effort stays a server startup setting.',
          );
        }
        if (!templateReasoningEffortSupported) {
          notes.push(
            'The server did not report that its chat template consumes reasoning_effort, so model-specific thinking levels are not sent.',
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
      ...(cached?.streamingEvidence ? { streamingEvidence: cached.streamingEvidence } : {}),
      reasoningEffortSupported,
      templateReasoningEffortSupported,
      propsCheckedAt: now,
    });

    return {
      streamingVerified: cached?.streamingVerified ?? false,
      ...(cached?.streamingEvidence ? { streamingEvidence: cached.streamingEvidence } : {}),
      reasoningEffortSupported,
      templateReasoningEffortSupported,
      notes,
      ...(validToolCapability ? { toolCalling: validToolCapability } : {}),
    };
  }

  /**
   * Verify that the endpoint really delivers Server-Sent Events. The result is
   * cached per base URL.
   */
  async probeStreaming(
    target: UpstreamTarget,
    options: { model?: string; timeoutMs: number },
  ): Promise<{ supported: boolean; detail: string; evidence?: StreamingEvidence }> {
    const { baseUrl, apiKey } = await this.resolveTarget(target);
    const key = this.capabilityKey(baseUrl, apiKey);
    const cached = this.capabilities.get(key);

    if (cached?.streamingVerified) {
      return {
        supported: true,
        detail: cached.streamingEvidence
          ? 'Streaming was verified for this endpoint earlier in this server session.'
          : 'Streaming was verified for this endpoint earlier.',
        ...(cached.streamingEvidence ? { evidence: cached.streamingEvidence } : {}),
      };
    }

    let model = options.model?.trim() || '';
    if (!model) {
      // Same "first model the server reports" contract as ordinary chat and
      // the tool-calling probe; failures are reported, never simulated.
      try {
        const discovered = await this.listModels(target, options.timeoutMs);
        model = discovered[0]?.trim() || '';
      } catch {
        model = '';
      }
    }
    if (!model) {
      return { supported: false, detail: 'A model ID is required to probe streaming, and the automatic discovery at /v1/models returned no usable model.' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs, 30_000));
    const startedAt = Date.now();

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const response = await this.pinnedFetch(joinApiPath(baseUrl, '/chat/completions'), {
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
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now(), streamingEvidence: undefined });
        return {
          supported: false,
          detail: `The endpoint answered the streaming probe with a redirect (HTTP ${response.status}).`,
        };
      }

      if (!response.ok) {
        const detail = `The streaming probe returned HTTP ${response.status}.`;
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now(), streamingEvidence: undefined });
        return { supported: false, detail };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('text/event-stream')) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now(), streamingEvidence: undefined });
        return {
          supported: false,
          detail: `The endpoint answered with content type "${contentType || 'unknown'}" instead of text/event-stream.`,
        };
      }

      if (!response.body) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now(), streamingEvidence: undefined });
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
      let contentEvents = 0;
      let firstContentMs: number | undefined;

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
          const carriedContent = (delta.content?.length ?? 0) + (delta.reasoning?.length ?? 0);
          if (carriedContent > 0) {
            characters += carriedContent;
            contentEvents += 1;
            if (firstContentMs === undefined) firstContentMs = Date.now() - startedAt;
          }
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
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now(), streamingEvidence: undefined });
        return { supported: false, detail: redactSecrets(streamError, [apiKey]) };
      }

      if (characters === 0) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now(), streamingEvidence: undefined });
        return {
          supported: false,
          detail: 'The event stream contained no answer text (keep-alive comments and empty deltas are not enough).',
        };
      }

      if (!finished) {
        this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now(), streamingEvidence: undefined });
        return {
          supported: false,
          detail:
            'The event stream ended without [DONE] or a finish reason; the answer may be truncated.',
        };
      }

      const durationMs = Math.max(0, Date.now() - startedAt);
      const detail =
        `The endpoint delivered ${characters} character(s) in ${contentEvents} content event(s) ` +
        `(first after ${firstContentMs ?? durationMs} ms) over a text/event-stream response and ended it with a finish marker. ` +
        'This verifies upstream delivery only; the browser rendering path is covered separately.';
      const evidence: StreamingEvidence = {
        verifiedAt: new Date().toISOString(),
        events,
        contentEvents,
        firstContentMs: firstContentMs ?? durationMs,
        durationMs,
        detail,
      };
      this.storeCapability(key, {
        streamingVerified: true,
        streamingCheckedAt: Date.now(),
        streamingEvidence: evidence,
      });
      return { supported: true, detail, evidence };
    } catch (error) {
      const apiError = toApiError(error);
      this.storeCapability(key, { streamingVerified: false, streamingCheckedAt: Date.now(), streamingEvidence: undefined });
      return { supported: false, detail: apiError.message };
    } finally {
      clearTimeout(timer);
    }
  }

  private storeCapability(key: string, update: Partial<CapabilityCacheEntry>): void {
    const current = this.capabilities.get(key) ?? {
      streamingVerified: false,
      streamingCheckedAt: 0,
      streamingEvidence: undefined,
      reasoningEffortSupported: false,
      templateReasoningEffortSupported: false,
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
    // Ordinary chat never grants tools, so a stored tool-use prompt variant
    // must not claim tool access on this request. Only the known
    // tool-environment paragraph and tool-rules block are touched; every
    // other prompt passes through unchanged. The tool loop builds its own
    // request body and is not affected.
    const truthfulMessages = messages.map((message) =>
      message.role === 'system'
        ? { ...message, content: neutralizeToolClaimsForOrdinaryChat(message.content ?? '') }
        : message,
    );
    // Model-specific thinking levels: the catalog entry of the concrete model
    // ID decides which values its template accepts. An unrecognized model
    // gets no policy and therefore keeps the previous behavior.
    const entry = findCatalogEntryByModelId(model);
    const reasoningPolicy: ReasoningPolicy | undefined = entry?.thinking
      ? {
          allowed: entry.thinking.levels,
          label: `${entry.displayName}'s chat template`,
        }
      : undefined;
    const { body } = buildChatCompletionBody({
      model,
      messages: truthfulMessages,
      params,
      capabilities,
      ...(reasoningPolicy ? { reasoningPolicy } : {}),
    });
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

/**
 * llama.cpp computes `chat_template_caps` by actually rendering the template.
 * `supports_reasoning_effort === true` therefore means that the loaded
 * template read the variable; it is the only signal the app trusts for the
 * model-specific thinking-level control.
 */
function propsReportTemplateReasoningEffort(props: ServerProps): boolean {
  const caps = props.chat_template_caps;
  return !!caps && typeof caps === 'object' && caps.supports_reasoning_effort === true;
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
