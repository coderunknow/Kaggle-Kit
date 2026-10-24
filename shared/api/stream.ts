/**
 * Minimal Server-Sent Events parser.
 *
 * Used by the local proxy backend (to inspect the upstream stream) and by the
 * browser client (to read the proxied stream). Only the subset of SSE that
 * OpenAI-compatible servers emit is supported.
 */

import type { OpenAIToolCall } from './types';

/**
 * The largest a single SSE event may grow while waiting for its blank-line
 * separator. A stream that never terminates an event would otherwise buffer
 * data without bound until the request timeout; every legitimate
 * OpenAI-compatible delta frame is far smaller than this.
 */
export const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

export interface SseEvent {
  /** Optional `event:` name. */
  event?: string;
  /** Concatenated `data:` payload. */
  data: string;
}

/**
 * Parse a `text/event-stream` body into SSE events.
 *
 * The stream is decoded with a UTF-8 aware buffer so multi byte characters
 * that are split across chunk boundaries are not corrupted.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // An abort must wake a read that is still waiting for the next chunk:
  // checking the signal only at the top of the loop leaves a pending
  // `reader.read()` hanging until the server happens to send more data, so
  // a timeout/abort of a silent stream would never take effect.
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal && !signal.aborted) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // An event that does not terminate grows this buffer instead of being
      // delivered; without a cap a stream that omits the blank-line separator
      // would accumulate data for the whole request timeout.
      if (buffer.length > MAX_SSE_EVENT_BYTES) {
        throw new Error('The event stream exceeded the maximum size of a single event before it terminated.');
      }

      let separator = findEventSeparator(buffer);
      while (separator) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
        separator = findEventSeparator(buffer);
      }
    }

    // A cancelled stream must not deliver a trailing partial event after the
    // cancellation: the caller has already decided the answer is incomplete.
    if (!signal?.aborted) {
      buffer += decoder.decode();
      const trailing = parseSseBlock(buffer);
      if (trailing) yield trailing;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // The body is closed when the loop was left early (a cancelled request),
    // so the connection is not left open.
    try {
      await reader.cancel();
    } catch {
      /* the stream is already closed */
    }
    reader.releaseLock?.();
  }
}

/**
 * Find the end of the first event in the buffer.
 *
 * The SSE specification allows LF, CRLF and CR as line ends. A server that
 * answers with CRLF would otherwise be read as one single event.
 */
function findEventSeparator(buffer: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  if (!match) return null;
  return { index: match.index, length: match[0].length };
}

function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split('\n');
  const dataLines: string[] = [];
  let eventName: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'event') {
      eventName = value;
    }
  }

  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join('\n') };
}

/** One streamed fragment of a tool call. Argument JSON arrives in pieces. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsFragment?: string;
}

export interface StreamDelta {
  content?: string;
  reasoning?: string;
  finishReason?: string;
  /** Streamed tool-call fragments. They are data only until assembled and validated. */
  toolCalls?: ToolCallDelta[];
  /**
   * An error that the server reported *inside* the event stream. The proxy
   * emits such an event when an upstream stream breaks, so that a truncated
   * answer is never mistaken for a finished one.
   */
  error?: string;
}

/** Extract the delta payload of an OpenAI-compatible SSE chunk. */
export function extractDelta(event: SseEvent): StreamDelta {
  if (event.data === '[DONE]') return { finishReason: 'stop' };

  let payload: {
    choices?: {
      delta?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }[];
    error?: { message?: string } | string;
  };

  try {
    payload = JSON.parse(event.data);
  } catch {
    return {};
  }

  const reportedError = payload.error;
  if (typeof reportedError === 'string') {
    if (reportedError.trim()) return { error: reportedError };
  } else if (reportedError?.message) {
    return { error: reportedError.message };
  }

  const choice = payload.choices?.[0];
  if (!choice) return {};

  const delta: StreamDelta = {};
  const content = choice.delta?.content;
  if (typeof content === 'string' && content.length > 0) delta.content = content;

  // llama.cpp streams chain-of-thought as `reasoning_content`; vLLM (and
  // therefore Raon/Qwen served through it) uses `reasoning`. They are two
  // spellings of the same channel: the canonical field wins when both are
  // present, and reasoning is never merged into the final `content`.
  const reasoningContent = choice.delta?.reasoning_content;
  const reasoning =
    typeof reasoningContent === 'string' && reasoningContent.length > 0
      ? reasoningContent
      : choice.delta?.reasoning;
  if (typeof reasoning === 'string' && reasoning.length > 0) delta.reasoning = reasoning;

  const fragments = choice.delta?.tool_calls;
  if (Array.isArray(fragments) && fragments.length > 0) {
    delta.toolCalls = fragments.flatMap((fragment, position): ToolCallDelta[] => {
      if (!fragment || typeof fragment !== 'object') return [];
      const index = typeof fragment.index === 'number' && Number.isInteger(fragment.index) && fragment.index >= 0
        ? fragment.index
        : position;
      return [{
        index,
        ...(typeof fragment.id === 'string' && fragment.id ? { id: fragment.id } : {}),
        ...(typeof fragment.function?.name === 'string' && fragment.function.name ? { name: fragment.function.name } : {}),
        ...(typeof fragment.function?.arguments === 'string' ? { argumentsFragment: fragment.function.arguments } : {}),
      }];
    });
  }

  if (choice.finish_reason) delta.finishReason = choice.finish_reason;

  return delta;
}

export interface AssembledToolCalls {
  calls: OpenAIToolCall[];
  /** True when a limit was hit; the partial data must not be executed. */
  overflow: boolean;
  /** True only when the stream announced `finish_reason=tool_calls`. */
  announced: boolean;
}

/**
 * Assemble streamed tool-call fragments into complete calls.
 *
 * Partial argument JSON is never parsed or executed here: the fragments are
 * concatenated per `index` and only handed back once the stream finishes.
 * A caller must additionally require `announced` (finish_reason=tool_calls),
 * validate each call's JSON against the tool schema and apply the normal
 * approval policy before anything runs.
 */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id?: string; name?: string; arguments: string; conflict?: boolean }>();
  private finishReason: string | undefined;
  private overflow = false;

  constructor(
    private readonly maxCalls = 8,
    private readonly maxArgumentBytes = 32_768,
  ) {}

  add(delta: StreamDelta): void {
    if (delta.finishReason) this.finishReason = delta.finishReason;
    for (const fragment of delta.toolCalls ?? []) {
      if (!this.byIndex.has(fragment.index)) {
        if (this.byIndex.size >= this.maxCalls) {
          this.overflow = true;
          continue;
        }
        this.byIndex.set(fragment.index, { arguments: '' });
      }
      const entry = this.byIndex.get(fragment.index)!;
      // One index is one call. A second, different id or function name on the
      // same index is a provider/protocol error: merging the fragments would
      // fabricate a call that correlates with neither, so the whole entry is
      // poisoned and reported as overflow instead of being handed back.
      if (fragment.id && entry.id && fragment.id !== entry.id) entry.conflict = true;
      if (fragment.name && entry.name && fragment.name !== entry.name) entry.conflict = true;
      if (fragment.id && !entry.id) entry.id = fragment.id;
      if (fragment.name && !entry.name) entry.name = fragment.name;
      if (fragment.argumentsFragment) {
        if (new TextEncoder().encode(entry.arguments + fragment.argumentsFragment).length > this.maxArgumentBytes) {
          this.overflow = true;
        } else {
          entry.arguments += fragment.argumentsFragment;
        }
      }
    }
  }

  finish(): AssembledToolCalls {
    const calls = [...this.byIndex.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, entry]): OpenAIToolCall[] => {
        if (!entry.id || !entry.name || entry.conflict) return [];
        return [{
          id: entry.id,
          type: 'function',
          function: { name: entry.name, arguments: entry.arguments },
        }];
      });
    return {
      calls,
      overflow: this.overflow || calls.length !== this.byIndex.size,
      announced: this.finishReason === 'tool_calls',
    };
  }
}
