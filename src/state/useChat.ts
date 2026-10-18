/**
 * Chat controller.
 *
 * Owns the request lifecycle: building the message history, calling the
 * local proxy, streaming or not, cancelling, retrying and editing. It is the
 * only place that turns an API response into conversation state.
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
function buildHistory(conversation: Conversation, profile: ApiProfile): ChatMessageInput[] {
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

export interface ChatController {
  sendMessage: (conversationId: string, content: string) => Promise<void>;
  resendMessage: (conversationId: string, userMessageId: string) => Promise<void>;
  retryMessage: (conversationId: string, assistantMessageId: string) => Promise<void>;
  editMessage: (conversationId: string, userMessageId: string, content: string) => Promise<void>;
  isPending: (conversationId: string) => boolean;
}

export function useChat(): ChatController {
  const app = useApp();
  const stateRef = useRef(app.state);
  const pendingRef = useRef(new Set<string>());

  /**
   * Mirror of the conversations that is updated synchronously. React state
   * updates are asynchronous, so reading `app.state` right after a dispatch
   * would return a stale conversation and silently drop messages.
   */
  const conversationsRef = useRef(new Map<string, Conversation>());

  useEffect(() => {
    stateRef.current = app.state;
    for (const conversation of app.state.conversations) {
      if (!conversationsRef.current.has(conversation.id)) {
        conversationsRef.current.set(conversation.id, conversation);
      }
    }
  }, [app.state]);

  /** Write a conversation to the mirror and to the application state. */
  const commitConversation = useCallback(
    (conversation: Conversation) => {
      conversationsRef.current.set(conversation.id, conversation);
      app.updateConversation(conversation);
    },
    [app],
  );

  const patchMessage = useCallback(
    (conversationId: string, messageId: string, changes: Partial<ChatMessage>) => {
      const conversation = conversationsRef.current.get(conversationId);
      if (!conversation) return;

      const messages = conversation.messages.map((message) =>
        message.id === messageId ? { ...message, ...changes } : message,
      );

      commitConversation({
        ...conversation,
        messages,
        updatedAt: new Date().toISOString(),
      });
    },
    [commitConversation],
  );

  const performRequest = useCallback(
    async (
      conversationId: string,
      profile: ApiProfile,
      history: ChatMessageInput[],
      assistantMessageId: string,
    ) => {
      const state = stateRef.current;
      const credential = resolveCredential(state.sessionKeys, state.browserKeys, profile);
      const capabilities = state.capabilities[profile.id];
      const params: InferenceParams = {
        ...profile.defaultParams,
        // Streaming is only used when the backend verified the transport.
        stream: Boolean(profile.defaultParams.stream && capabilities?.streamingVerified),
      };

      const controller = new AbortController();
      app.registerRequest(conversationId, controller);

      try {
        const result = await gateway.chat(
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
                const conversation = conversationsRef.current.get(conversationId);
                const message = conversation?.messages.find((item) => item.id === assistantMessageId);
                if (!message) return;

                patchMessage(conversationId, assistantMessageId, {
                  content: `${message.content}${delta.content ?? ''}`,
                  reasoning: delta.reasoning
                    ? `${message.reasoning ?? ''}${delta.reasoning}`
                    : message.reasoning,
                });
              },
            },
          },
        );

        const usage = result.response.usage;
        patchMessage(conversationId, assistantMessageId, {
          content: result.content,
          status: 'complete',
          model: result.response.model ?? profile.modelId,
          reasoning: result.reasoning,
          usage: usage && Object.keys(usage).length > 0 ? usage : undefined,
          errorKind: undefined,
          errorMessage: undefined,
          errorHint: undefined,
        });
      } catch (error) {
        const aborted = error instanceof ApiError && error.kind === 'aborted';
        const apiError = error instanceof ApiError ? error : undefined;

        patchMessage(conversationId, assistantMessageId, {
          status: aborted ? 'cancelled' : 'error',
          errorKind: apiError?.kind ?? 'unknown',
          errorMessage: aborted
            ? 'The request was cancelled.'
            : apiError?.message ?? (error instanceof Error ? error.message : String(error)),
          errorHint: aborted ? undefined : apiError?.hint,
        });
      } finally {
        app.finishRequest(conversationId);
        pendingRef.current.delete(conversationId);
      }
    },
    [app, patchMessage],
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

      commitConversation({
        ...conversation,
        messages: [...conversation.messages, assistantMessage],
        updatedAt: new Date().toISOString(),
      });
      pendingRef.current.add(conversationId);

      await performRequest(conversationId, profile, history, assistantMessage.id);
    },
    [commitConversation, performRequest],
  );

  const resolveProfile = useCallback(
    (conversation: Conversation): ApiProfile | undefined => {
      const state = stateRef.current;
      const profileId = conversation.profileId ?? state.preferences.activeProfileId;
      return state.profiles.find((item) => item.id === profileId);
    },
    [],
  );

  const sendMessage = useCallback(
    async (conversationId: string, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      if (pendingRef.current.has(conversationId)) return;

      const state = stateRef.current;
      const conversation = state.conversations.find((item) => item.id === conversationId);
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

      commitConversation(updatedConversation);

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
        commitConversation({
          ...updatedConversation,
          messages: [...updatedConversation.messages, assistantMessage],
        });
        return;
      }

      const history = buildHistory(updatedConversation, profile);
      await startRequest(conversationId, profile, history, updatedConversation);
    },
    [commitConversation, resolveProfile, startRequest],
  );

  /** Re-send an existing user message, dropping everything after it. */
  const resendMessage = useCallback(
    async (conversationId: string, userMessageId: string) => {
      if (pendingRef.current.has(conversationId)) return;

      const state = stateRef.current;
      const conversation = state.conversations.find((item) => item.id === conversationId);
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
      commitConversation(truncated);

      await startRequest(conversationId, profile, buildHistory(truncated, profile), truncated);
    },
    [commitConversation, resolveProfile, startRequest],
  );

  /** Retry a failed or cancelled assistant message. */
  const retryMessage = useCallback(
    async (conversationId: string, assistantMessageId: string) => {
      if (pendingRef.current.has(conversationId)) return;

      const state = stateRef.current;
      const conversation = state.conversations.find((item) => item.id === conversationId);
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
      commitConversation(truncated);

      await startRequest(conversationId, profile, buildHistory(truncated, profile), truncated);
    },
    [commitConversation, resolveProfile, startRequest],
  );

  /** Edit a user message and resend the conversation from that point. */
  const editMessage = useCallback(
    async (conversationId: string, userMessageId: string, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      if (pendingRef.current.has(conversationId)) return;

      const state = stateRef.current;
      const conversation = state.conversations.find((item) => item.id === conversationId);
      if (!conversation) return;

      const index = conversation.messages.findIndex((message) => message.id === userMessageId);
      if (index === -1) return;

      const target = conversation.messages[index];
      if (!target || target.role !== 'user') return;

      const profile = resolveProfile(conversation);
      if (!profile) return;

      const editedMessages = conversation.messages
        .slice(0, index)
        .map((message) => (message.id === userMessageId ? { ...message, content: trimmed } : message));

      const edited: Conversation = {
        ...conversation,
        title: index === 0 ? titleFromMessage(trimmed) : conversation.title,
        messages: editedMessages,
        updatedAt: new Date().toISOString(),
      };
      commitConversation(edited);

      await startRequest(conversationId, profile, buildHistory(edited, profile), edited);
    },
    [commitConversation, resolveProfile, startRequest],
  );

  const isPending = useCallback(
    (conversationId: string) => pendingRef.current.has(conversationId),
    [],
  );

  return { sendMessage, resendMessage, retryMessage, editMessage, isPending };
}
