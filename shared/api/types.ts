/**
 * Wire types for the OpenAI-compatible HTTP API exposed by llama.cpp.
 *
 * These types intentionally describe only the subset of the schema that the
 * chat client actually relies on. Optional members are omitted from requests
 * when they are not applicable, so the server never receives parameters it
 * does not understand.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** JSON Schema object used for function parameters. */
export type JsonSchema = Record<string, unknown>;

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: JsonSchema;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessageInput {
  role: ChatRole;
  content: string | null;
  /** Tool calls are only valid on assistant messages. */
  tool_calls?: OpenAIToolCall[];
  /** Correlation identifier for a tool result. */
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export interface ModelListResponse {
  object?: string;
  data?: OpenAIModel[];
}

/** Token accounting as reported by the server. Never fabricated locally. */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface CompletionMessage {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  /** llama.cpp exposes chain-of-thought under several names depending on build. */
  reasoning_content?: string | null;
  reasoning?: string | null;
}

export interface CompletionChoice {
  index?: number;
  message?: CompletionMessage;
  delta?: Partial<CompletionMessage>;
  finish_reason?: string | null;
}

export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: CompletionChoice[];
  usage?: TokenUsage;
  error?: { message?: string; type?: string; code?: string | number };
}

export interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessageInput[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  reasoning_effort?: string;
  tools?: OpenAIToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required';
  parallel_tool_calls?: boolean;
}

/** Subset of llama.cpp's `/props` response that we use for capability checks. */
export interface ServerProps {
  default_generation_settings?: Record<string, unknown>;
  total_slots?: number;
  model_path?: string;
  chat_template?: string;
  build_info?: string;
  [key: string]: unknown;
}
