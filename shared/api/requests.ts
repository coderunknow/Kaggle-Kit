/**
 * Request construction for the OpenAI-compatible chat endpoint.
 *
 * The rule enforced here: never send a parameter the connected server does
 * not support. Parameters that are unsupported are omitted rather than sent
 * with a guessed value, and the caller is told what was left out.
 */

import type { ChatCompletionRequestBody, ChatMessageInput, OpenAIToolDefinition } from './types';
import type { ToolCallingCapability } from '../tools/types';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface InferenceParams {
  /** Maximum number of tokens to generate. */
  maxTokens: number;
  temperature: number;
  topP: number;
  /** `undefined` means "do not send this parameter". */
  frequencyPenalty?: number;
  presencePenalty?: number;
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
  reasoningEffort: null,
  stream: false,
};

export interface BuildChatBodyInput {
  model: string;
  messages: ChatMessageInput[];
  params: InferenceParams;
  capabilities?: ServerCapabilities;
  tools?: OpenAIToolDefinition[];
}

export interface BuildChatBodyResult {
  body: ChatCompletionRequestBody;
  /** Parameters that were intentionally left out. */
  omitted: string[];
}

export function buildChatCompletionBody(input: BuildChatBodyInput): BuildChatBodyResult {
  const { model, messages, params } = input;
  const capabilities = input.capabilities;
  const omitted: string[] = [];

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

  if (params.reasoningEffort) {
    if (capabilities?.reasoningEffortSupported) {
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

  return { body, omitted };
}

/**
 * Reasoning effort in llama.cpp is a *server startup* option
 * (`--reasoning-effort`). Sending it per request only works on builds that
 * accept the field. This helper keeps the two concepts apart in the UI.
 */
export const REASONING_EFFORT_STARTUP_NOTE =
  'Reasoning effort is applied by llama.cpp as a server startup flag. It is only sent per request when the connected server advertises support for it.';
