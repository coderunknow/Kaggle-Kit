/**
 * Minimal Server-Sent Events parser.
 *
 * Used by the local proxy backend (to inspect the upstream stream) and by the
 * browser client (to read the proxied stream). Only the subset of SSE that
 * OpenAI-compatible servers emit is supported.
 */

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

  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = findEventSeparator(buffer);
      while (separator) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
        separator = findEventSeparator(buffer);
      }
    }

    buffer += decoder.decode();
    const trailing = parseSseBlock(buffer);
    if (trailing) yield trailing;
  } finally {
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

export interface StreamDelta {
  content?: string;
  reasoning?: string;
  finishReason?: string;
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
    choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
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

  const reasoning = choice.delta?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.length > 0) delta.reasoning = reasoning;

  if (choice.finish_reason) delta.finishReason = choice.finish_reason;

  return delta;
}
