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
import type { SourceCitation, ToolCallingCapability, ToolProfileSettings, ToolTraceRecord, ToolTurnDiagnostics, UploadedFileReference } from '../../shared/tools/types';

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

export interface ToolChatRequest extends TargetRequest {
  profileId: string;
  conversationId: string;
  model: string;
  messages: ChatMessageInput[];
  params: InferenceParams;
  conversationSettings?: import('../../shared/tools/types').ConversationToolSettings;
}

export interface ToolChatResult {
  status: 'complete' | 'awaiting_approval';
  jobId?: string;
  content: string;
  reasoning?: string;
  model: string;
  finishReason?: string;
  usage?: ChatCompletionResponse['usage'];
  toolTrace: ToolTraceRecord[];
  toolDiagnostics?: ToolTurnDiagnostics;
  sourceCitations: SourceCitation[];
  persistToolHistory: boolean;
  transientContent?: boolean;
  pendingApproval?: {
    jobId: string;
    approvalId: string;
    callId: string;
    toolName: string;
    description: string;
    target?: string;
    arguments: Record<string, unknown>;
    expiresAt: string;
  };
}

async function requestJson<T>(path: string, body: unknown, signal?: AbortSignal, method = 'POST'): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    let streamError: string | undefined;

    try {
      for await (const event of parseSseStream(body, options.signal)) {
        const delta = extractDelta(event);
        if (delta.error) {
          // The proxy reports a broken upstream stream as an event. Stopping
          // here is what keeps a truncated answer from being shown as complete.
          streamError = delta.error;
          break;
        }
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
    } catch (error) {
      if (options.signal?.aborted) {
        throw new ApiError('aborted', 'The request was cancelled.', { cause: error });
      }
      throw new ApiError('inference', 'The connection broke while the answer was streamed.', {
        hint: 'The partial answer was kept; retry the request.',
        cause: error,
      });
    }

    // A stream that was cancelled is not a finished answer. Reporting it as
    // complete would show a truncated answer as if the model had finished.
    if (options.signal?.aborted) {
      throw new ApiError('aborted', 'The request was cancelled.');
    }

    if (streamError) {
      throw new ApiError('inference', streamError, {
        hint: 'The connection broke while the answer was streamed. The partial answer was kept; retry the request.',
      });
    }

    // Some servers close the stream without [DONE] but with a finish reason.
    // Neither of both means that the answer was cut off and must not be
    // presented as a finished answer.
    if (!finishReason) {
      throw new ApiError('inference', 'The event stream ended before the model marked the answer as complete.', {
        hint: 'The answer may be truncated. Retry the request, or disable streaming for this endpoint.',
      });
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

  /** Store sanitized tool settings in the local proxy's protected store. */
  async getToolProfile(profileId: string, signal?: AbortSignal): Promise<ToolProfileSettings | null> {
    const payload = await requestJson<{ settings: ToolProfileSettings | null }>(
      `/api/tools/profile?profileId=${encodeURIComponent(profileId)}`,
      undefined,
      signal,
      'GET',
    );
    return payload.settings ?? null;
  },

  async saveToolProfile(profileId: string, settings: ToolProfileSettings, signal?: AbortSignal): Promise<ToolProfileSettings> {
    const payload = await requestJson<{ settings: ToolProfileSettings }>('/api/tools/profile', { profileId, settings }, signal, 'PUT');
    return payload.settings;
  },

  async deleteToolProfile(profileId: string, signal?: AbortSignal): Promise<void> {
    await requestJson(`/api/tools/profile?profileId=${encodeURIComponent(profileId)}`, undefined, signal, 'DELETE');
  },

  async probeToolCalling(target: TargetRequest, signal?: AbortSignal): Promise<ToolCallingCapability> {
    return requestJson<ToolCallingCapability>('/api/tools/capability', { ...target }, signal);
  },

  async toolChat(request: ToolChatRequest, signal?: AbortSignal): Promise<ToolChatResult> {
    return requestJson<ToolChatResult>('/api/tools/chat', request, signal);
  },

  async approveToolCall(input: { jobId: string; approvalId: string; approved: boolean }, signal?: AbortSignal): Promise<ToolChatResult> {
    return requestJson<ToolChatResult>('/api/tools/approve', input, signal);
  },

  async cancelToolJob(jobId: string, signal?: AbortSignal): Promise<boolean> {
    const result = await requestJson<{ ok: boolean }>('/api/tools/cancel', { jobId }, signal);
    return result.ok;
  },

  async discoverMcpTools(profileId: string, serverId: string, signal?: AbortSignal): Promise<{ tools: import('../../shared/tools/types').McpDiscoveredTool[]; granted: false; message: string }> {
    return requestJson('/api/tools/mcp/discover', { profileId, serverId }, signal);
  },

  async grantMcpServer(profileId: string, serverId: string, signal?: AbortSignal): Promise<ToolProfileSettings> {
    const payload = await requestJson<{ settings: ToolProfileSettings }>('/api/tools/mcp/grant', { profileId, serverId }, signal);
    return payload.settings;
  },

  async listConversationFiles(conversationId: string, signal?: AbortSignal): Promise<UploadedFileReference[]> {
    const payload = await requestJson<{ files: UploadedFileReference[] }>(
      `/api/tools/files?conversationId=${encodeURIComponent(conversationId)}`,
      undefined,
      signal,
      'GET',
    );
    return payload.files ?? [];
  },

  async deleteConversationFiles(conversationId: string, signal?: AbortSignal): Promise<void> {
    await requestJson(`/api/tools/files?conversationId=${encodeURIComponent(conversationId)}`, undefined, signal, 'DELETE');
  },

  async uploadConversationFile(conversationId: string, file: File, signal?: AbortSignal): Promise<UploadedFileReference> {
    if (file.size > 4 * 1024 * 1024) throw new ApiError('bad_request', 'Files must be 4 MiB or smaller.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 32_768)));
    }
    const contentBase64 = btoa(binary);
    const payload = await requestJson<{ file: UploadedFileReference }>('/api/tools/files/upload', {
      conversationId,
      name: file.name,
      mediaType: file.type || 'application/octet-stream',
      contentBase64,
    }, signal);
    return payload.file;
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
