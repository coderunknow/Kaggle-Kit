/**
 * Request construction for the OpenAI-compatible chat endpoint.
 *
 * The rule enforced here: never send a parameter the connected server does
 * not support. Parameters that are unsupported are omitted rather than sent
 * with a guessed value, and the caller is told what was left out.
 */

import type { ChatCompletionRequestBody, ChatMessageInput, OpenAIToolDefinition } from './types';
import type { ToolCallingCapability } from '../tools/types';

/**
 * Request-time reasoning effort values the API can carry. `none` is only
 * meaningful for a model whose template documents a disabled thinking level
 * (Spark-X2.6); the generic control keeps offering low/medium/high.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/**
 * Model-specific constraints for the `reasoning_effort` field.
 *
 * It is passed by the caller that knows the concrete model ID (the proxy and
 * the settings UI both resolve it from the catalog). Without a policy the
 * builder keeps the historical behavior: send the value only when the
 * endpoint advertised a generic per-request `reasoning_effort` support.
 */
export interface ReasoningPolicy {
  /** Levels this model's own chat template accepts. */
  allowed: readonly ReasoningEffort[];
  /** Human readable mechanism, used in the omission note. */
  label: string;
}

export interface InferenceParams {
  /** Maximum number of tokens to generate. */
  maxTokens: number;
  temperature: number;
  topP: number;
  /** `undefined` means "do not send this parameter". */
  frequencyPenalty?: number;
  presencePenalty?: number;
  /**
   * Sampling extensions (`top_k`, `min_p`, `repetition_penalty`). These are
   * not part of the strict OpenAI schema, so they follow the same rule as the
   * penalties: `undefined` means the field is never sent. Model-specific
   * catalog defaults (for example Raon's) set them explicitly per profile;
   * they never leak into profiles that did not opt in.
   */
  topK?: number;
  minP?: number;
  repetitionPenalty?: number;
  /** Request time reasoning effort. Only sent when the server supports it. */
  reasoningEffort?: ReasoningEffort | null;
  /** Only honoured when the transport was verified to support SSE. */
  stream: boolean;
}

export interface ServerCapabilities {
  /** True only after a real SSE request succeeded against the endpoint. */
  streamingVerified: boolean;
  /** True when the server accepts a per request `reasoning_effort`. */
  reasoningEffortSupported: boolean;
  /**
   * True only when the server itself reported that the loaded chat template
   * consumes the `reasoning_effort` variable (llama.cpp /props
   * `chat_template_caps.supports_reasoning_effort`, computed by rendering the
   * template). Required for model-specific thinking levels.
   */
  templateReasoningEffortSupported?: boolean;
  /** Optional human readable note, e.g. "configured at server startup". */
  notes: string[];
  /** Independent native tool-calling probe result; never inferred from connection health. */
  toolCalling?: ToolCallingCapability;
}

export const DEFAULT_INFERENCE_PARAMS: InferenceParams = {
  maxTokens: 1024,
  temperature: 0.7,
  topP: 0.95,
  frequencyPenalty: undefined,
  presencePenalty: undefined,
  topK: undefined,
  minP: undefined,
  repetitionPenalty: undefined,
  reasoningEffort: null,
  stream: false,
};

export interface BuildChatBodyInput {
  model: string;
  messages: ChatMessageInput[];
  params: InferenceParams;
  capabilities?: ServerCapabilities;
  tools?: OpenAIToolDefinition[];
  /** Model-specific constraint for `reasoning_effort`; absent for other models. */
  reasoningPolicy?: ReasoningPolicy;
}

export interface BuildChatBodyResult {
  body: ChatCompletionRequestBody;
  /** Parameters that were intentionally left out. */
  omitted: string[];
  /** Why a parameter was left out; shown next to the omission list. */
  notes: string[];
}

export function buildChatCompletionBody(input: BuildChatBodyInput): BuildChatBodyResult {
  const { model, messages, params } = input;
  const capabilities = input.capabilities;
  const omitted: string[] = [];
  const notes: string[] = [];

  const body: ChatCompletionRequestBody = {
    model,
    messages,
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    top_p: params.topP,
  };

  if (params.frequencyPenalty !== undefined) {
    body.frequency_penalty = params.frequencyPenalty;
  } else {
    omitted.push('frequency_penalty');
  }

  if (params.presencePenalty !== undefined) {
    body.presence_penalty = params.presencePenalty;
  } else {
    omitted.push('presence_penalty');
  }

  if (params.topK !== undefined) {
    body.top_k = params.topK;
  } else {
    omitted.push('top_k');
  }

  if (params.minP !== undefined) {
    body.min_p = params.minP;
  } else {
    omitted.push('min_p');
  }

  if (params.repetitionPenalty !== undefined) {
    body.repetition_penalty = params.repetitionPenalty;
  } else {
    omitted.push('repetition_penalty');
  }

  if (params.reasoningEffort) {
    if (input.reasoningPolicy) {
      // A model-specific control: the value has to be one the model's own
      // template accepts *and* the server has to confirm that the template
      // consumes it. A value the template would reject (for example
      // "medium" on Spark-X2.6, whose template raises) is never sent.
      if (!input.reasoningPolicy.allowed.includes(params.reasoningEffort)) {
        omitted.push('reasoning_effort');
        notes.push(
          `reasoning_effort "${params.reasoningEffort}" is not a level of ${input.reasoningPolicy.label}; ` +
            `supported: ${input.reasoningPolicy.allowed.join(', ')}. It was not sent.`,
        );
      } else if (!capabilities?.templateReasoningEffortSupported) {
        omitted.push('reasoning_effort');
        notes.push(
          'The connected server did not confirm that the loaded chat template consumes reasoning_effort, ' +
            'so the thinking level was not sent.',
        );
      } else {
        body.reasoning_effort = params.reasoningEffort;
      }
    } else if (capabilities?.reasoningEffortSupported) {
      body.reasoning_effort = params.reasoningEffort;
    } else {
      omitted.push('reasoning_effort');
    }
  }

  const toolCallingReady = Boolean(
    input.tools && input.tools.length > 0 && capabilities?.toolCalling?.status === 'supported_verified',
  );

  if (params.stream) {
    if (capabilities?.streamingVerified && !toolCallingReady) {
      body.stream = true;
    } else if (toolCallingReady) {
      omitted.push('stream (tool turns use non-streaming requests; streamed tool-call support is reported separately by the capability probe)');
    } else {
      omitted.push('stream');
    }
  }

  if (input.tools && input.tools.length > 0) {
    if (toolCallingReady) {
      body.tools = input.tools.map(({ type, function: fn }) => ({ type, function: fn }));
      body.tool_choice = 'auto';
      // Tool execution is sequential by default. The app does not rely on model-side parallelism.
      body.parallel_tool_calls = false;
    } else {
      omitted.push('tools');
    }
  }

  return { body, omitted, notes };
}

/**
 * Reasoning effort in llama.cpp is a *server startup* option
 * (`--reasoning-effort`). Sending it per request only works on builds that
 * accept the field. This helper keeps the two concepts apart in the UI.
 */
export const REASONING_EFFORT_STARTUP_NOTE =
  'Reasoning effort is applied by llama.cpp as a server startup flag. It is only sent per request when the connected server advertises support for it.';
