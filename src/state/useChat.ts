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
import { effectiveProfileTarget, resolveProfileCredential } from '../../shared/connection';
import type { ChatMessageInput } from '../../shared/api/types';
import type { ApiProfile, ChatMessage, Conversation } from '../../shared/domain';
import { effectiveToolSelection, type ConversationToolSettings, type ToolProfileSettings, type ToolTraceRecord } from '../../shared/tools/types';
import { gateway, type ToolChatResult } from '../lib/gateway';
import { createId, titleFromMessage } from '../lib/id';
import { useApp } from './AppProvider';

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

export function markToolTraceCancelled(
  trace: ToolTraceRecord[],
  cancelledAt = new Date().toISOString(),
): { trace: ToolTraceRecord[]; operationMayHaveStarted: boolean } {
  const operationMayHaveStarted = trace.some((entry) => entry.status === 'approved' || entry.status === 'running');
  const updated = trace.map((entry): ToolTraceRecord => {
    if (entry.status === 'awaiting_approval') {
      return {
        ...entry,
        status: 'cancelled',
        approvalState: 'stale',
        approvalId: undefined,
        completedAt: cancelledAt,
        resultSummary: 'Cancelled by the user before approval; the operation was not run.',
      };
    }
    if (entry.status === 'approved' || entry.status === 'running') {
      return {
        ...entry,
        status: 'interrupted',
        approvalState: 'stale',
        approvalId: undefined,
        completedAt: cancelledAt,
        resultSummary: 'Cancellation was requested after approval; the operation may have started or completed and may not be reversible.',
      };
    }
    if (entry.status === 'denied' && entry.approvalId) {
      return {
        ...entry,
        approvalId: undefined,
        completedAt: entry.completedAt ?? cancelledAt,
        resultSummary: 'Denied by the user; the operation was not run.',
      };
    }
    return entry;
  });
  return { trace: updated, operationMayHaveStarted };
}

export interface ChatController {
  sendMessage: (conversationId: string, content: string) => Promise<void>;
  resendMessage: (conversationId: string, userMessageId: string) => Promise<void>;
  retryMessage: (conversationId: string, assistantMessageId: string) => Promise<void>;
  editMessage: (conversationId: string, userMessageId: string, content: string) => Promise<void>;
  approveToolCall: (conversationId: string, messageId: string, approvalId: string, approved: boolean) => Promise<void>;
  cancelToolJob: (conversationId: string) => Promise<void>;
  isPending: (conversationId: string) => boolean;
}

export function useChat(): ChatController {
  const app = useApp();
  // The provider value changes with every state update. The controller reads
  // it through a ref so its callbacks keep their identity.
  const appRef = useRef(app);
  const pendingRef = useRef(new Set<string>());
  const approvalActionsRef = useRef(new Set<string>());

  useEffect(() => {
    appRef.current = app;
  }, [app]);

  const patchMessage = useCallback(
    (conversationId: string, messageId: string, changes: Partial<ChatMessage>) => {
      appRef.current.dispatch({ type: 'messages/patch', conversationId, messageId, changes });
    },
    [],
  );

  const applyToolChatResult = useCallback((conversationId: string, messageId: string, result: ToolChatResult): boolean => {
    const waiting = result.status === 'awaiting_approval';
    if (waiting && (!result.jobId || !result.pendingApproval?.approvalId)) {
      throw new ApiError('invalid_response', 'The proxy returned an incomplete tool-approval request.');
    }
    appRef.current.dispatch({
      type: 'conversations/patch',
      id: conversationId,
      changes: { toolHistoryPersistence: result.persistToolHistory, updatedAt: new Date().toISOString() },
    });
    // Surface the bounded-recovery diagnostics and any context-pressure hint
    // so the UI never implies a smooth run when a corrective round happened.
    const notes: string[] = [];
    if (result.recovery && result.recovery.attempts > 0) {
      notes.push(`Corrective recovery: ${result.recovery.attempts} corrective round(s) used; outcome: ${result.recovery.outcome === 'corrected' ? 'the retry produced a valid turn' : 'recovery failed; see the activity timeline for what remains undone'}.`);
    }
    if (result.contextNotice) notes.push(result.contextNotice);
    patchMessage(conversationId, messageId, {
      content: result.content,
      status: waiting ? 'pending' : 'complete',
      model: result.model,
      reasoning: result.reasoning,
      finishReason: result.finishReason,
      usage: result.usage,
      transport: 'complete',
      streamFellBack: false,
      toolTrace: result.toolTrace,
      sourceCitations: result.sourceCitations,
      transientToolContent: result.transientContent === true,
      toolJobId: waiting ? result.jobId : undefined,
      toolNote: notes.length > 0 ? notes.join(' ') : undefined,
      errorKind: undefined,
      errorMessage: undefined,
      errorHint: undefined,
    });
    return waiting;
  }, [patchMessage]);

  const performRequest = useCallback(
    async (
      conversationId: string,
      profile: ApiProfile,
      history: ChatMessageInput[],
      assistantMessageId: string,
      conversationSettings?: ConversationToolSettings,
    ) => {
      const state = appRef.current.state;
      const credential = resolveProfileCredential(profile, state);
      const capabilities = state.capabilities[profile.id];

      // Streaming is only requested when this session verified it. The proxy
      // verifies it again and enforces it server side.
      const wantsStream = Boolean(profile.defaultParams.stream && capabilities?.streamingVerified);
      const configuredTools = profile.tools as ToolProfileSettings | undefined;
      const toolsSelected = Boolean(configuredTools?.enabled && effectiveToolSelection(configuredTools, conversationSettings).length > 0);
      const toolCallingVerified = capabilities?.toolCalling?.status === 'supported_verified';
      let toolNote: string | undefined;
      let waitingForApproval = false;

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
            baseUrl: effectiveProfileTarget(profile).baseUrl,
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
        if (toolsSelected && toolCallingVerified) {
          try {
            const toolResult = await gateway.toolChat({
              profileId: profile.id,
              conversationId,
              baseUrl: effectiveProfileTarget(profile).baseUrl,
              model: profile.modelId,
              messages: history,
              params: { ...profile.defaultParams, stream: false },
              conversationSettings,
              timeoutMs: profile.timeoutMs,
              ...credential,
            }, controller.signal);
            waitingForApproval = applyToolChatResult(conversationId, assistantMessageId, toolResult);
            return;
          } catch (error) {
            if (!(error instanceof ApiError) || error.httpStatus !== 409) throw error;
            toolNote = `${error.message} Ordinary chat was used; no tools were executed.`;
          }
        } else if (toolsSelected) {
          toolNote = `Tool calls were not sent because native support has not been verified for this exact model and endpoint. Ordinary chat was used.`;
        }

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
          toolNote,
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
          toolNote,
        });
      } finally {
        if (flushTimer !== null) window.clearTimeout(flushTimer);
        appRef.current.finishRequest(conversationId);
        if (!waitingForApproval) pendingRef.current.delete(conversationId);
      }
    },
    [applyToolChatResult, patchMessage],
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

      await performRequest(conversationId, profile, history, assistantMessage.id, conversation.toolSettings);
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

  const approveToolCall = useCallback(async (conversationId: string, messageId: string, approvalId: string, approved: boolean) => {
    if (approvalActionsRef.current.has(conversationId)) return;
    const conversation = findConversation(conversationId);
    const message = conversation?.messages.find((entry) => entry.id === messageId);
    const trace = message?.toolTrace?.find((entry) => entry.approvalId === approvalId && entry.status === 'awaiting_approval');
    if (!message?.toolJobId || !trace) return;
    approvalActionsRef.current.add(conversationId);
    patchMessage(conversationId, messageId, {
      toolTrace: (message.toolTrace ?? []).map((entry) => entry.approvalId === approvalId
        ? { ...entry, status: approved ? 'approved' : 'denied', approvalState: approved ? 'approved' : 'denied' }
        : entry),
    });
    const controller = new AbortController();
    appRef.current.registerRequest(conversationId, controller);
    try {
      const result = await gateway.approveToolCall({ jobId: message.toolJobId, approvalId, approved }, controller.signal);
      const waiting = applyToolChatResult(conversationId, messageId, result);
      if (waiting) pendingRef.current.add(conversationId);
      else pendingRef.current.delete(conversationId);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : undefined;
      const aborted = apiError?.kind === 'aborted';
      patchMessage(conversationId, messageId, {
        status: aborted ? 'cancelled' : 'error',
        toolJobId: undefined,
        toolTrace: (message.toolTrace ?? []).map((entry) => entry.approvalId === approvalId
          ? { ...entry, status: aborted ? 'cancelled' : 'failed', approvalState: aborted ? 'stale' : 'approved', approvalId: undefined, error: apiError?.message ?? 'The approval request could not be completed.' }
          : entry),
        toolNote: undefined,
        errorKind: apiError?.kind ?? 'unknown',
        errorMessage: aborted ? 'The approval request was cancelled.' : apiError?.message ?? 'The tool approval could not be completed.',
        errorHint: aborted ? undefined : apiError?.hint,
      });
      pendingRef.current.delete(conversationId);
    } finally {
      appRef.current.finishRequest(conversationId);
      approvalActionsRef.current.delete(conversationId);
    }
  }, [applyToolChatResult, findConversation, patchMessage]);

  const cancelToolJob = useCallback(async (conversationId: string) => {
    const conversation = findConversation(conversationId);
    const pendingMessage = conversation?.messages.slice().reverse().find((entry) => entry.role === 'assistant' && entry.status === 'pending' && entry.toolJobId);
    if (!pendingMessage?.toolJobId) {
      appRef.current.cancelRequest(conversationId);
      return;
    }
    // If an approval action is in flight, abort its HTTP request as well as
    // deleting the server-side job so the executing tool receives cancellation.
    appRef.current.cancelRequest(conversationId);
    try {
      await gateway.cancelToolJob(pendingMessage.toolJobId);
    } catch {
      // An expired or already-cancelled job cannot execute a later approval.
    }
    const cancellation = markToolTraceCancelled(pendingMessage.toolTrace ?? []);
    patchMessage(conversationId, pendingMessage.id, {
      status: 'cancelled',
      toolJobId: undefined,
      toolTrace: cancellation.trace,
      toolNote: cancellation.operationMayHaveStarted
        ? 'Cancellation was requested. The approved operation may already have started or completed; check the target service for its final state.'
        : 'The pending tool request was cancelled. No approved operation was run.',
    });
    pendingRef.current.delete(conversationId);
  }, [findConversation, patchMessage]);

  const isPending = useCallback(
    (conversationId: string) => pendingRef.current.has(conversationId),
    [],
  );

  return { sendMessage, resendMessage, retryMessage, editMessage, approveToolCall, cancelToolJob, isPending };
}
