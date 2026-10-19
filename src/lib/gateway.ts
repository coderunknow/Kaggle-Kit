/**
 * Browser side gateway.
 *
 * The browser never talks to the model server directly. It calls this
 * project's own backend, which proxies the request. That removes the CORS
 * problem and keeps the API key out of the browser whenever the profile uses
 * the "server" credential mode.
 *
 * All requests are same-origin relative URLs: no key, no host and no
 * credential ever appears in a URL.
 */

import { ApiError } from '../../shared/api/errors';
import type { ServerCapabilities } from '../../shared/api/requests';
import type { InferenceParams } from '../../shared/api/requests';
import type { ChatCompletionResponse, ChatMessageInput } from '../../shared/api/types';
import type { ConnectionTestResult } from '../../shared/domain';

export interface TargetRequest {
  baseUrl: string;
  /** Key for the session/browser credential modes. */
  apiKey?: string;
  /** Reference into the backend secret store for the "server" mode. */
  secretRef?: string;
  model?: string;
  timeoutMs?: number;
}

export interface ChatRequest extends TargetRequest {
  model: string;
  messages: ChatMessageInput[];
  params: InferenceParams;
  capabilities?: ServerCapabilities;
}

export interface StreamCallbacks {
  onDelta?: (delta: { content?: string; reasoning?: string }) => void;
  onDone?: (result: { finishReason?: string }) => void;
}

export interface ChatResult {
  response: ChatCompletionResponse;
  /** True when the response arrived as a Server-Sent Event stream. */
  streamed: boolean;
  content: string;
  reasoning?: string;
  finishReason?: string;
}

async function requestJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new ApiError('aborted', 'The request was cancelled.', { cause: error });
    }
    throw new ApiError(
      'network',
      'The local proxy could not be reached. Make sure the backend is running.',
      { cause: error },
    );
  }

  const text = await response.text();

  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError('invalid_response', 'The local proxy returned a response that is not valid JSON.');
  }

  if (!response.ok) {
    const error = (payload as { error?: { message?: string; kind?: string; hint?: string } })?.error;
    throw new ApiError((error?.kind as ApiError['kind']) ?? 'server', error?.message ?? `The proxy returned HTTP ${response.status}.`, {
      httpStatus: response.status,
      hint: error?.hint,
    });
  }

  return payload as T;
}

export const gateway = {
  /** Health check of the local backend. */
  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch('/api/health', { signal });
      return response.ok;
    } catch {
      return false;
    }
  },

  /** List the model IDs exposed by the configured endpoint. */
  async listModels(target: TargetRequest, signal?: AbortSignal): Promise<string[]> {
    const payload = await requestJson<{ models: string[] }>(
      '/api/proxy/models',
      { ...target },
      signal,
    );
    return payload.models ?? [];
  },

  /** Run the full connection test (model discovery + real inference). */
  async testConnection(target: TargetRequest, signal?: AbortSignal): Promise<ConnectionTestResult> {
    return requestJson<ConnectionTestResult>('/api/proxy/test', { ...target }, signal);
  },

  /** Verify that the endpoint really supports SSE streaming. */
  async probeStreaming(
    target: TargetRequest,
    signal?: AbortSignal,
  ): Promise<{ supported: boolean; detail: string }> {
    return requestJson<{ supported: boolean; detail: string }>(
      '/api/proxy/probe-stream',
      { ...target },
      signal,
    );
  },

  /** Send a chat request. Uses SSE when the backend confirmed support. */
  async chat(request: ChatRequest, options: { signal?: AbortSignal; callbacks?: StreamCallbacks } = {}): Promise<ChatResult> {
    let response: Response;
    try {
      response = await fetch('/api/proxy/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new ApiError('aborted', 'The request was cancelled.', { cause: error });
      }
      throw new ApiError(
        'network',
        'The local proxy could not be reached. Make sure the backend is running.',
        { cause: error },
      );
    }

    if (!response.ok) {
      const text = await response.text();
      let message = `The proxy returned HTTP ${response.status}.`;
      let kind: ApiError['kind'] = 'server';
      let hint: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; kind?: string; hint?: string } };
        if (parsed.error?.message) message = parsed.error.message;
        if (parsed.error?.kind) kind = parsed.error.kind as ApiError['kind'];
        hint = parsed.error?.hint;
      } catch {
        /* keep the generic message */
      }
      throw new ApiError(kind, message, { httpStatus: response.status, hint });
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.toLowerCase().includes('text/event-stream') && response.body) {
      return this.readStream(response.body, options);
    }

    const payload = (await response.json()) as { response?: ChatCompletionResponse };
    const completion = payload.response;
    if (!completion) {
      throw new ApiError('invalid_response', 'The proxy returned no completion payload.');
    }

    const choice = completion.choices?.[0];
    const content = choice?.message?.content ?? '';
    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? undefined;

    return {
      response: completion,
      streamed: false,
      content,
      reasoning,
      finishReason: choice?.finish_reason ?? undefined,
    };
  },

  async readStream(
    body: ReadableStream<Uint8Array>,
    options: { signal?: AbortSignal; callbacks?: StreamCallbacks } = {},
  ): Promise<ChatResult> {
    const { parseSseStream, extractDelta } = await import('../../shared/api/stream');
    let content = '';
    let reasoning = '';
    let finishReason: string | undefined;

    for await (const event of parseSseStream(body, options.signal)) {
      const delta = extractDelta(event);
      if (delta.content) {
        content += delta.content;
        options.callbacks?.onDelta?.({ content: delta.content });
      }
      if (delta.reasoning) {
        reasoning += delta.reasoning;
        options.callbacks?.onDelta?.({ reasoning: delta.reasoning });
      }
      if (delta.finishReason) finishReason = delta.finishReason;
    }

    // A stream that was cancelled is not a finished answer. Reporting it as
    // complete would show a truncated answer as if the model had finished.
    if (options.signal?.aborted) {
      throw new ApiError('aborted', 'The request was cancelled.');
    }

    options.callbacks?.onDone?.({ finishReason });

    return {
      response: { choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }] },
      streamed: true,
      content,
      reasoning: reasoning || undefined,
      finishReason,
    };
  },

  /** Store a key in the backend secret store. */
  async saveSecret(reference: string, apiKey: string): Promise<void> {
    await requestJson('/api/secrets', { ref: reference, apiKey });
  },

  /** Delete a key from the backend secret store. */
  async deleteSecret(reference: string): Promise<void> {
    const response = await fetch(`/api/secrets/${encodeURIComponent(reference)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new ApiError('server', `The proxy returned HTTP ${response.status} while deleting the key.`);
    }
  },

  /** List the references stored in the backend secret store. */
  async listSecrets(): Promise<string[]> {
    const response = await fetch('/api/secrets');
    if (!response.ok) {
      throw new ApiError('server', `The proxy returned HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as { references?: string[] };
    return payload.references ?? [];
  },
};
