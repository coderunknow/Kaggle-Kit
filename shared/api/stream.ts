/**
 * Minimal Server-Sent Events parser.
 *
 * Used by the local proxy backend (to inspect the upstream stream) and by the
 * browser client (to read the proxied stream). Only the subset of SSE that
 * OpenAI-compatible servers emit is supported.
 */

import type { ApiErrorKind } from './errors';
import type { OpenAIToolCall } from './types';

/**
 * Machine codes the local proxy may attach to a terminal SSE error event.
 *
 * The table alone is *not* a trust boundary: the proxy forwards complete
 * upstream event blocks verbatim, so an upstream server can also send an
 * `error` object whose `code` is one of these keys. Classification therefore
 * requires proof of origin, not just a known code (see
 * `PROXY_STREAM_NONCE_HEADER` and `extractDelta`). Without that proof the
 * payload is an ordinary upstream error and the browser reports it as an
 * inference failure.
 */
export const PROXY_STREAM_ERROR_KINDS = {
  stream_timeout: 'timeout',
  client_cancelled: 'aborted',
  upstream_stream_failed: 'inference',
  stream_event_too_large: 'inference',
} as const satisfies Record<string, ApiErrorKind>;

export type ProxyStreamErrorCode = keyof typeof PROXY_STREAM_ERROR_KINDS;

/**
 * Response header carrying the random marker the proxy generated for *this*
 * streaming response.
 *
 * The proxy writes terminal error events itself, but it also forwards upstream
 * bytes unchanged. A code in the fixed table is only trusted when the same
 * event carries this per-response nonce: the upstream never receives the
 * value, so it cannot reproduce it. The header is read from the same-origin
 * response the browser is already consuming, which is why no CORS exposure is
 * needed; a cross-origin deployment would have to expose it explicitly.
 */
export const PROXY_STREAM_NONCE_HEADER = 'x-kaggle-kit-stream-nonce';

/**
 * The largest number of UTF-8 bytes a single SSE event may have. An event is
 * the text between two blank-line separators, event fields included. The
 * parser measures the actual encoded bytes of the undelivered tail: multi
 * byte text counts its real bytes (not code units), and one oversized
 * network chunk of many small events is still delivered (the cap bounds one
 * event, not a chunk). A stream that never terminates an event would
 * otherwise buffer data without bound until the request timeout; every
 * legitimate OpenAI-compatible delta frame is far smaller than this.
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
  // One streaming decoder for the whole stream, fed only complete event
  // blocks (plus the final flush). A multi-byte character split across a
  // chunk boundary is therefore held back by the decoder until the bytes
  // that complete it arrive, exactly as in a raw byte stream.
  const decoder = new TextDecoder('utf-8');

  // The undelivered tail as raw wire bytes in arrival order. Keeping bytes
  // (instead of one ever-growing string) makes the byte cap exact and keeps
  // the work per chunk proportional to the chunk: scanning, slicing or
  // re-encoding the whole growing tail for every small chunk would make a
  // never-terminated event quadratic in its size.
  const segments: Uint8Array[] = [];
  let firstSeg = 0; // segments[] index of the tail start
  let segOffset = 0; // consumed bytes within segments[firstSeg]
  let tailBytes = 0; // total raw bytes in the tail

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

  const exceedLimit = () => {
    throw new Error('The event stream exceeded the maximum size of a single event before it terminated.');
  };

  // The last `length` bytes of the tail: the new chunk plus at most three
  // bytes that a separator may straddle back into the previous data.
  const tailWindow = (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    let need = length;
    for (let seg = segments.length - 1; need > 0 && seg >= firstSeg; seg -= 1) {
      const piece = segments[seg]!;
      const available = seg === firstSeg ? piece.byteLength - segOffset : piece.byteLength;
      const take = Math.min(need, available);
      out.set(piece.subarray(available - take, available), need - take);
      need -= take;
    }
    return out;
  };

  // The first `to` bytes of the tail (one completed event block).
  const tailPrefix = (to: number): Uint8Array => {
    const out = new Uint8Array(to);
    let filled = 0;
    for (let seg = firstSeg; filled < to && seg < segments.length; seg += 1) {
      const piece = segments[seg]!;
      const from = seg === firstSeg ? segOffset : 0;
      const take = Math.min(piece.byteLength - from, to - filled);
      out.set(piece.subarray(from, from + take), filled);
      filled += take;
    }
    return out;
  };

  const advanceTail = (count: number): void => {
    segOffset += count;
    tailBytes -= count;
    while (firstSeg < segments.length && segOffset >= segments[firstSeg]!.byteLength) {
      segOffset -= segments[firstSeg]!.byteLength;
      firstSeg += 1;
    }
  };

  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      segments.push(value);
      tailBytes += value.byteLength;

      // A separator is pure ASCII (LF, CRLF, CR) and UTF-8 multi-byte
      // sequences never contain 0x0A/0x0D, so searching raw bytes is exact.
      // A separator can only appear inside the new chunk or straddle its
      // start by at most three bytes, so only that window is scanned: the
      // per-chunk work stays O(chunk) no matter how large the pending tail
      // is.
      const windowStart = Math.max(0, tailBytes - value.byteLength - 3);
      const window = tailWindow(tailBytes - windowStart);
      let scan = 0;
      let consumed = 0;
      for (;;) {
        const separator = findSeparator(window, windowStart, scan);
        if (!separator) break;
        const blockEnd = separator.absStart + separator.length;
        const block = tailPrefix(separator.absStart - consumed);
        advanceTail(blockEnd - consumed);
        consumed = blockEnd;
        const parsed = parseSseBlock(decoder.decode(block, { stream: true }));
        if (parsed) {
          if (block.byteLength > MAX_SSE_EVENT_BYTES) exceedLimit();
          yield parsed;
        }
        // Every remaining separator must also touch the new chunk (the tail
        // had none before this chunk), so the copied window still covers it.
        scan = blockEnd - windowStart;
      }

      // After the split the tail holds exactly one unterminated event, so
      // this bounds a single event, not the size of one network chunk: a
      // chunk full of small complete events passes the check above.
      if (tailBytes > MAX_SSE_EVENT_BYTES) exceedLimit();
    }

    // A cancelled stream must not deliver a trailing partial event after the
    // cancellation: the caller has already decided the answer is incomplete.
    if (!signal?.aborted && tailBytes > 0) {
      // The final flush decodes the tail plus the bytes the decoder held
      // back; only here can an event cross the limit at the very end.
      const rest = tailPrefix(tailBytes);
      if (rest.byteLength > MAX_SSE_EVENT_BYTES) exceedLimit();
      const trailing = parseSseBlock(decoder.decode(rest));
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

const LF = 0x0a;
const CR = 0x0d;

/**
 * Find the end of the first event at or after `from` within `window` (a
 * byte-range copy of the tail, starting at tail offset `windowStart`).
 *
 * The SSE specification allows LF, CRLF and CR as line ends, so a server
 * that answers with CRLF would otherwise be read as one single event. The
 * byte scan matches the leftmost-first behavior of the old regex
 * (`\r\n\r\n|\n\n|\r\r`) exactly.
 */
function findSeparator(window: Uint8Array, windowStart: number, from: number): { absStart: number; length: number } | null {
  for (let i = from; i + 2 <= window.byteLength; i += 1) {
    const a = window[i]!;
    const b = window[i + 1]!;
    if (a === LF && b === LF) return { absStart: windowStart + i, length: 2 };
    if (a === CR && b === CR) return { absStart: windowStart + i, length: 2 };
    if (a === CR && b === LF && i + 4 <= window.byteLength && window[i + 2] === CR && window[i + 3] === LF) {
      return { absStart: windowStart + i, length: 4 };
    }
  }
  return null;
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
  /** Machine code as reported in the event: proxy-generated *or* upstream text. */
  errorCode?: string;
  /**
   * Classification derived from `errorCode`. It is only set when the event
   * also proves it came from this proxy (per-response nonce), never from the
   * message text and never from a bare code.
   */
  errorKind?: ApiErrorKind;
}

/**
 * Extract the delta payload of an OpenAI-compatible SSE chunk.
 *
 * `trustedNonce` is the marker from `PROXY_STREAM_NONCE_HEADER` of the response
 * being read. A known code without that exact marker stays unclassified, so an
 * upstream that sends `{"error":{"code":"stream_timeout"}}` cannot make the
 * browser claim the proxy timed out.
 */
export function extractDelta(event: SseEvent, trustedNonce?: string): StreamDelta {
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
    error?: { message?: string; code?: string; nonce?: string } | string;
  } | null;

  try {
    payload = JSON.parse(event.data);
  } catch {
    return {};
  }
  if (!payload || typeof payload !== 'object') return {};

  const reportedError = payload.error;
  if (typeof reportedError === 'string') {
    if (reportedError.trim()) return { error: reportedError };
  } else if (reportedError?.message) {
    const code = typeof reportedError.code === 'string' ? reportedError.code : undefined;
    // Provenance first: a matching nonce means this event was written by the
    // proxy for this response. The upstream never sees the value, so a known
    // code that arrives with a missing, empty or different marker is still
    // only an untrusted payload.
    const trusted = typeof trustedNonce === 'string'
      && trustedNonce.length > 0
      && reportedError.nonce === trustedNonce;
    const known = trusted
      && code !== undefined
      && Object.prototype.hasOwnProperty.call(PROXY_STREAM_ERROR_KINDS, code);
    return {
      error: reportedError.message,
      ...(code ? { errorCode: code } : {}),
      ...(known ? { errorKind: PROXY_STREAM_ERROR_KINDS[code as ProxyStreamErrorCode] } : {}),
    };
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
