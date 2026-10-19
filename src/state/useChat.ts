/**
 * Chat controller.
 *
 * Owns the request lifecycle: building the message history, calling the
 * local proxy, streaming or not, cancelling, retrying and editing. It is the
 * only place that turns an API response into conversation state.
 *
 * The controller keeps its callbacks stable (it reads the provider through a
 * ref) so that a message list can memoise its rows while an answer streams.
 */

import { useCallback, useEffect, useRef } from 'react';

import { ApiError } from '../../shared/api/errors';
import type { InferenceParams } from '../../shared/api/requests';
import type { ChatMessageInput } from '../../shared/api/types';
import type { ApiProfile, ChatMessage, Conversation } from '../../shared/domain';
import { gateway } from '../lib/gateway';
import { createId, titleFromMessage } from '../lib/id';
import { useApp } from './AppProvider';

interface CredentialTarget {
  apiKey?: string;
  secretRef?: string;
}

function resolveCredential(
  sessionKeys: Record<string, string>,
  browserKeys: Record<string, string>,
  profile: ApiProfile,
): CredentialTarget {
  switch (profile.credentialStorage) {
    case 'session':
      return { apiKey: sessionKeys[profile.id] };
    case 'browser':
      return { apiKey: browserKeys[profile.id] };
    case 'server':
      return { secretRef: profile.secretRef };
    default:
      return {};
  }
}

/**
 * Build the request history: the system prompt plus every finished message.
 * Failed, cancelled and still pending messages are never sent upstream.
 */
export function buildHistory(conversation: Conversation, profile: ApiProfile): ChatMessageInput[] {
  const history: ChatMessageInput[] = [];

  const systemPrompt = profile.systemPrompt.trim();
  if (systemPrompt) {
    history.push({ role: 'system', content: systemPrompt });
  }

  for (const message of conversation.messages) {
    if (message.role === 'user' && message.content.trim()) {
      history.push({ role: 'user', content: message.content });
    } else if (
      message.role === 'assistant' &&
      message.status === 'complete' &&
      message.content.trim()
    ) {
      history.push({ role: 'assistant', content: message.content });
    }
  }

  return history;
}

/** How long streamed deltas are collected before the state is updated. */
const DELTA_FLUSH_MS = 40;

export interface ChatController {
  sendMessage: (conversationId: string, content: string) => Promise<void>;
  resendMessage: (conversationId: string, userMessageId: string) => Promise<void>;
  retryMessage: (conversationId: string, assistantMessageId: string) => Promise<void>;
  editMessage: (conversationId: string, userMessageId: string, content: string) => Promise<void>;
  isPending: (conversationId: string) => boolean;
}

export function useChat(): ChatController {
  const app = useApp();
  // The provider value changes with every state update. The controller reads
  // it through a ref so its callbacks keep their identity.
  const appRef = useRef(app);
  const pendingRef = useRef(new Set<string>());

  useEffect(() => {
    appRef.current = app;
  }, [app]);

  const patchMessage = useCallback(
    (conversationId: string, messageId: string, changes: Partial<ChatMessage>) => {
      appRef.current.dispatch({ type: 'messages/patch', conversationId, messageId, changes });
    },
    [],
  );

  const performRequest = useCallback(
    async (
      conversationId: string,
      profile: ApiProfile,
      history: ChatMessageInput[],
      assistantMessageId: string,
    ) => {
      const state = appRef.current.state;
      const credential = resolveCredential(state.sessionKeys, state.browserKeys, profile);
      const capabilities = state.capabilities[profile.id];

      // Streaming is only requested when this session verified it. The proxy
      // verifies it again and enforces it server side.
      const wantsStream = Boolean(profile.defaultParams.stream && capabilities?.streamingVerified);

      let pendingContent = '';
      let pendingReasoning = '';
      let flushTimer: number | null = null;
      let receivedDelta = false;

      const flushDeltas = () => {
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (!pendingContent && !pendingReasoning) return;
        appRef.current.dispatch({
          type: 'messages/append',
          conversationId,
          messageId: assistantMessageId,
          ...(pendingContent ? { content: pendingContent } : {}),
          ...(pendingReasoning ? { reasoning: pendingReasoning } : {}),
        });
        pendingContent = '';
        pendingReasoning = '';
      };

      const scheduleFlush = () => {
        if (flushTimer !== null) return;
        flushTimer = window.setTimeout(() => {
          flushTimer = null;
          flushDeltas();
        }, DELTA_FLUSH_MS);
      };

      const controller = new AbortController();
      appRef.current.registerRequest(conversationId, controller);

      const run = async (stream: boolean) => {
        const params: InferenceParams = { ...profile.defaultParams, stream };
        return gateway.chat(
          {
            baseUrl: profile.baseUrl,
            model: profile.modelId,
            messages: history,
            params,
            capabilities,
            timeoutMs: profile.timeoutMs,
            ...credential,
          },
          {
            signal: controller.signal,
            callbacks: {
              onDelta: (delta) => {
                receivedDelta = true;
                if (delta.content) pendingContent += delta.content;
                if (delta.reasoning) pendingReasoning += delta.reasoning;
                scheduleFlush();
              },
            },
          },
        );
      };

      let streamFellBack = false;

      try {
        let result;
        try {
          result = await run(wantsStream);
        } catch (error) {
          const canFallBack =
            wantsStream &&
            !receivedDelta &&
            error instanceof ApiError &&
            error.httpStatus === 409 &&
            error.kind === 'bad_request';

          if (!canFallBack) throw error;

          // The proxy refused streaming because it could not verify the
          // transport (for example after a restart). The request produced no
          // answer yet, so retrying without streaming cannot duplicate one.
          streamFellBack = true;
          result = await run(false);
        }

        flushDeltas();

        const usage = result.response.usage;
        patchMessage(conversationId, assistantMessageId, {
          content: result.content,
          status: 'complete',
          model: result.response.model ?? profile.modelId,
          reasoning: result.reasoning,
          finishReason: result.finishReason,
          usage: usage && Object.keys(usage).length > 0 ? usage : undefined,
          transport: result.streamed ? 'stream' : 'complete',
          streamFellBack,
          errorKind: undefined,
          errorMessage: undefined,
          errorHint: undefined,
        });
      } catch (error) {
        flushDeltas();

        const aborted = error instanceof ApiError && error.kind === 'aborted';
        const apiError = error instanceof ApiError ? error : undefined;

        patchMessage(conversationId, assistantMessageId, {
          status: aborted ? 'cancelled' : 'error',
          errorKind: apiError?.kind ?? 'unknown',
          errorMessage: aborted
            ? 'The request was cancelled.'
            : apiError?.message ?? (error instanceof Error ? error.message : String(error)),
          errorHint: aborted ? undefined : apiError?.hint,
          transport: receivedDelta ? 'stream' : undefined,
          streamFellBack,
        });
      } finally {
        if (flushTimer !== null) window.clearTimeout(flushTimer);
        appRef.current.finishRequest(conversationId);
        pendingRef.current.delete(conversationId);
      }
    },
    [patchMessage],
  );

  /** Append an assistant placeholder and run the request. */
  const startRequest = useCallback(
    async (
      conversationId: string,
      profile: ApiProfile,
      history: ChatMessageInput[],
      conversation: Conversation,
    ) => {
      const assistantMessage: ChatMessage = {
        id: createId('msg'),
        role: 'assistant',
        content: '',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      appRef.current.updateConversation({
        ...conversation,
        messages: [...conversation.messages, assistantMessage],
        updatedAt: new Date().toISOString(),
      });
      pendingRef.current.add(conversationId);

      await performRequest(conversationId, profile, history, assistantMessage.id);
    },
    [performRequest],
  );

  const resolveProfile = useCallback((conversation: Conversation): ApiProfile | undefined => {
    const state = appRef.current.state;
    const profileId = conversation.profileId ?? state.preferences.activeProfileId;
    return state.profiles.find((item) => item.id === profileId);
  }, []);

  const findConversation = useCallback(
    (conversationId: string): Conversation | undefined =>
      appRef.current.state.conversations.find((item) => item.id === conversationId),
    [],
  );

  const sendMessage = useCallback(
    async (conversationId: string, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      if (pendingRef.current.has(conversationId)) return;

      const conversation = findConversation(conversationId);
      if (!conversation) return;

      const profile = resolveProfile(conversation);
      const now = new Date().toISOString();

      const userMessage: ChatMessage = {
        id: createId('msg'),
        role: 'user',
        content: trimmed,
        status: 'complete',
        createdAt: now,
      };

      const updatedConversation: Conversation = {
        ...conversation,
        title:
          conversation.messages.length === 0 ? titleFromMessage(trimmed) : conversation.title,
        messages: [...conversation.messages, userMessage],
        updatedAt: now,
      };

      appRef.current.updateConversation(updatedConversation);

      if (!profile) {
        const assistantMessage: ChatMessage = {
          id: createId('msg'),
          role: 'assistant',
          content: '',
          status: 'error',
          createdAt: now,
          errorKind: 'bad_request',
          errorMessage: 'No connection profile is selected for this conversation.',
          errorHint: 'Open Settings, create a profile and select it before sending a message.',
        };
        appRef.current.updateConversation({
          ...updatedConversation,
          messages: [...updatedConversation.messages, assistantMessage],
        });
        return;
      }

      const history = buildHistory(updatedConversation, profile);
      await startRequest(conversationId, profile, history, updatedConversation);
    },
    [findConversation, resolveProfile, startRequest],
  );

  /** Re-send an existing user message, dropping everything after it. */
  const resendMessage = useCallback(
    async (conversationId: string, userMessageId: string) => {
      if (pendingRef.current.has(conversationId)) return;

      const conversation = findConversation(conversationId);
      if (!conversation) return;

      const index = conversation.messages.findIndex((message) => message.id === userMessageId);
      if (index === -1) return;

      const target = conversation.messages[index];
      if (!target || target.role !== 'user') return;

      const profile = resolveProfile(conversation);
      if (!profile) return;

      const truncated: Conversation = {
        ...conversation,
        messages: conversation.messages.slice(0, index + 1),
        updatedAt: new Date().toISOString(),
      };
      appRef.current.updateConversation(truncated);

      await startRequest(conversationId, profile, buildHistory(truncated, profile), truncated);
    },
    [findConversation, resolveProfile, startRequest],
  );

  /** Retry a failed or cancelled assistant message (and regenerate an answer). */
  const retryMessage = useCallback(
    async (conversationId: string, assistantMessageId: string) => {
      if (pendingRef.current.has(conversationId)) return;

      const conversation = findConversation(conversationId);
      if (!conversation) return;

      const index = conversation.messages.findIndex((message) => message.id === assistantMessageId);
      if (index === -1) return;

      const target = conversation.messages[index];
      if (!target || target.role !== 'assistant') return;

      const profile = resolveProfile(conversation);
      if (!profile) return;

      const truncated: Conversation = {
        ...conversation,
        messages: conversation.messages.slice(0, index),
        updatedAt: new Date().toISOString(),
      };
      appRef.current.updateConversation(truncated);

      await startRequest(conversationId, profile, buildHistory(truncated, profile), truncated);
    },
    [findConversation, resolveProfile, startRequest],
  );

  /** Edit a user message and resend the conversation from that point. */
  const editMessage = useCallback(
    async (conversationId: string, userMessageId: string, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      if (pendingRef.current.has(conversationId)) return;

      const conversation = findConversation(conversationId);
      if (!conversation) return;

      const index = conversation.messages.findIndex((message) => message.id === userMessageId);
      if (index === -1) return;

      const target = conversation.messages[index];
      if (!target || target.role !== 'user') return;

      const profile = resolveProfile(conversation);
      if (!profile) return;

      // Keep the edited message itself: the slice has to include its index.
      // Everything after it is dropped because it belongs to the old branch.
      const messages = conversation.messages
        .slice(0, index + 1)
        .map((message) =>
          message.id === userMessageId
            ? { ...message, content: trimmed, createdAt: new Date().toISOString() }
            : message,
        );

      const edited: Conversation = {
        ...conversation,
        title: index === 0 ? titleFromMessage(trimmed) : conversation.title,
        messages,
        updatedAt: new Date().toISOString(),
      };
      appRef.current.updateConversation(edited);

      await startRequest(conversationId, profile, buildHistory(edited, profile), edited);
    },
    [findConversation, resolveProfile, startRequest],
  );

  const isPending = useCallback(
    (conversationId: string) => pendingRef.current.has(conversationId),
    [],
  );

  return { sendMessage, resendMessage, retryMessage, editMessage, isPending };
}
