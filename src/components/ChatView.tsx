/**
 * The chat surface: the landing state, the message list, the jump-to-latest
 * control and the composer.
 *
 * The view never forces the scroll position: it follows new tokens only while
 * the reader is at the bottom, and offers a button otherwise. State changes
 * are announced through a quiet live region instead of making the message log
 * itself live, which would read every streamed token aloud.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';

import type { ConnectionViewState } from '../../shared/connection';
import type { ApiProfile, ChatMessage, Conversation } from '../../shared/domain';
import { effectiveToolSelection, shouldPersistToolHistory, type ConversationToolSettings, type UploadedFileReference } from '../../shared/tools/types';
import { gateway } from '../lib/gateway';
import { PROMPT_STARTERS } from '../lib/promptStarters';
import { useApp } from '../state/AppProvider';
import { useDraft } from '../state/useDraft';
import { Composer } from './Composer';
import { MessageItem } from './MessageItem';
import { Icon, StatusDot } from './ui';

export type ConnectionState = ConnectionViewState;

export interface ChatViewProps {
  conversation: Conversation | undefined;
  profile: ApiProfile | undefined;
  pending: boolean;
  connectionState: ConnectionState;
  onSend: (content: string) => void;
  onCancel: () => void;
  onToolApproval: (messageId: string, approvalId: string, approved: boolean) => void;
  onCopy: (message: ChatMessage) => Promise<boolean>;
  onEdit: (messageId: string, content: string) => void;
  onRetry: (messageId: string) => void;
  onResend: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onOpenSettings: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

function Landing({
  hasProfile,
  hasActiveProfile,
  connected,
  untested,
  stale,
  onOpenSettings,
}: {
  hasProfile: boolean;
  hasActiveProfile: boolean;
  connected: boolean;
  untested: boolean;
  stale: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="hero">
      <span className="hero__mark" aria-hidden="true">
        <Icon name="sparkle" size={24} />
      </span>
      <h2 className="hero__title">A private chat for your own model</h2>
      <p className="hero__lead">
        Kaggle-Kit connects this page to a model running on your Kaggle GPU through a small proxy
        on your machine. Prompts and answers stay between you and that endpoint.
      </p>

      <ol className="setup-list">
        <li className={`setup-list__item${hasProfile ? ' is-done' : ''}`}>
          <span className="setup-list__mark" aria-hidden="true">
            {hasProfile ? <Icon name="check" size={12} /> : '1'}
          </span>
          <div>
            <strong>Add a connection profile</strong>
            <p>The base URL and the API key of the model server, not of this page.</p>
          </div>
          {hasProfile ? null : (
            <button type="button" className="button button--small" onClick={onOpenSettings}>
              Add profile
            </button>
          )}
        </li>

        <li className={`setup-list__item${connected ? ' is-done' : ''}`}>
          <span className="setup-list__mark" aria-hidden="true">
            {connected ? <Icon name="check" size={12} /> : '2'}
          </span>
          <div>
            <strong>{hasProfile && !hasActiveProfile ? 'Select the active profile' : 'Test the connection'}</strong>
            <p>
              {!hasProfile
                ? 'Create a profile first; its test runs a real completion.'
                : !hasActiveProfile
                  ? 'More than one profile exists; choose the one this chat should use.'
                  : connected
                    ? 'The endpoint answered a real completion.'
                    : stale
                      ? 'The profile changed since the last test. Test the saved configuration again.'
                      : untested
                        ? 'A real model-list request and a real completion, before you write anything.'
                        : 'The last test failed. Check the URL and the key, then test again.'}
            </p>
          </div>
          {hasProfile && !connected ? (
            <button type="button" className="button button--small" onClick={onOpenSettings}>
              {hasActiveProfile ? 'Test' : 'Choose'}
            </button>
          ) : null}
        </li>

        <li className="setup-list__item">
          <span className="setup-list__mark" aria-hidden="true">
            3
          </span>
          <div>
            <strong>Write a message</strong>
            <p>The first message starts a conversation. Nothing is sent before you press Send.</p>
          </div>
        </li>
      </ol>

      <div className="hero__actions">
        <button type="button" className="button button--primary" onClick={onOpenSettings}>
          <Icon name="settings" size={14} />
          Connection settings
        </button>
      </div>
    </div>
  );
}

function Welcome({
  profile,
  onPickStarter,
}: {
  profile: ApiProfile;
  onPickStarter: (prompt: string) => void;
}) {
  return (
    <div className="welcome">
      <div className="welcome__heading">
        <span className="welcome__eyebrow">
          <StatusDot tone="ok" />
          {profile.name}
          <span className="welcome__model">{profile.modelId || 'first model of the server'}</span>
        </span>
        <h2>What would you like to work on?</h2>
        <p>
          This conversation is private to your machine. Answers come from the model server behind
          the local proxy.
        </p>
      </div>

      <div className="starters">
        <span className="starters__title">Start with an example</span>
        <div className="starters__grid">
          {PROMPT_STARTERS.map((starter) => (
            <button
              key={starter.id}
              type="button"
              className="starter"
              onClick={() => onPickStarter(starter.prompt)}
            >
              <span className="starter__title">{starter.title}</span>
              <span className="starter__description">{starter.description}</span>
              <Icon name="chevron-right" size={14} className="starter__arrow" />
            </button>
          ))}
        </div>
      </div>

      <p className="welcome__footnote">
        A starter fills the input; edit it before sending, nothing is sent automatically.
      </p>
    </div>
  );
}

export function ChatView({
  conversation,
  profile,
  pending,
  connectionState,
  onSend,
  onCancel,
  onToolApproval,
  onCopy,
  onEdit,
  onRetry,
  onResend,
  onRegenerate,
  onOpenSettings,
  composerRef,
}: ChatViewProps) {
  const app = useApp();
  const dispatch = app.dispatch;
  const [draft, setDraft] = useDraft(conversation?.id);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadedFilesRef = useRef<UploadedFileReference[]>(conversation?.uploadedFiles ?? []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const messages = conversation?.messages ?? [];
  const lastMessage = messages[messages.length - 1];
  const messageCount = messages.length;
  const lastId = lastMessage?.id ?? '';
  const lastStatus = lastMessage?.status ?? '';
  const lastLength = lastMessage?.content.length ?? 0;
  const conversationId = conversation?.id;
  const profileTools = profile?.tools;
  const availableToolIds = profileTools?.allowedTools ?? [];
  const selectedToolIds = conversation?.toolSettings?.toolIds ?? availableToolIds;
  const effectiveTools = profileTools ? effectiveToolSelection(profileTools, conversation?.toolSettings) : [];
  const canUploadFiles = Boolean(conversation && effectiveTools.some((id) => id.startsWith('files_')));
  const uploadedFiles = conversation?.uploadedFiles ?? [];

  useEffect(() => {
    uploadedFilesRef.current = conversation?.uploadedFiles ?? [];
  }, [conversation?.id, conversation?.uploadedFiles]);

  useEffect(() => {
    if (!conversationId) return undefined;
    let cancelled = false;
    void gateway.listConversationFiles(conversationId).then((files) => {
      if (cancelled) return;
      uploadedFilesRef.current = files;
      dispatch({
        type: 'conversations/patch',
        id: conversationId,
        changes: { uploadedFiles: files, updatedAt: new Date().toISOString() },
      });
    }).catch(() => {
      // Keep local metadata visible if the proxy is temporarily unavailable.
    });
    return () => { cancelled = true; };
  }, [conversationId, dispatch]);

  const updateConversationToolSettings = (changes: Partial<ConversationToolSettings>) => {
    if (!conversation) return;
    const toolSettings = { ...conversation.toolSettings, ...changes };
    const persistence = profileTools ? shouldPersistToolHistory(profileTools, toolSettings) : false;
    app.dispatch({
      type: 'conversations/patch',
      id: conversation.id,
      changes: {
        toolSettings,
        ...(changes.historyPersistence !== undefined ? { toolHistoryPersistence: persistence } : {}),
        updatedAt: new Date().toISOString(),
      },
    });
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!conversation || selected.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const remaining = Math.max(0, 16 - uploadedFilesRef.current.length);
      if (remaining === 0) throw new Error('This conversation already has the maximum of 16 in-memory uploads.');
      const uploaded: UploadedFileReference[] = [];
      for (const file of selected.slice(0, remaining)) {
        uploaded.push(await gateway.uploadConversationFile(conversation.id, file));
      }
      const next = [...uploadedFilesRef.current, ...uploaded];
      uploadedFilesRef.current = next;
      app.dispatch({
        type: 'conversations/patch',
        id: conversation.id,
        changes: { uploadedFiles: next, updatedAt: new Date().toISOString() },
      });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'The file could not be uploaded.');
    } finally {
      setUploading(false);
    }
  };

  const scrollToBottom = useCallback((smooth: boolean) => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottom.current = true;
    setShowJump(false);
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight, behavior: smooth && !reduced ? 'smooth' : 'auto' });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom(false);
  }, [conversation?.id, scrollToBottom]);

  // Follow new content only when the reader has not scrolled up.
  useEffect(() => {
    if (!stickToBottom.current) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messageCount, lastId, lastStatus, lastLength]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = distance < 64;
    setShowJump(distance > 140);
  };

  const pickStarter = (prompt: string) => {
    setDraft(prompt);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(prompt.length, prompt.length);
    });
  };

  const announcement = !lastMessage
    ? ''
    : lastStatus === 'pending'
      ? 'The assistant is responding.'
      : lastStatus === 'complete'
        ? 'The answer is complete.'
        : lastStatus === 'cancelled'
          ? 'The answer was cancelled.'
          : lastStatus === 'error'
            ? `The request failed. ${lastMessage.errorMessage ?? ''}`
            : '';

  const missingProfile = !profile;
  const placeholder = missingProfile
    ? 'Add a connection profile before writing a message'
    : 'Ask anything…';

  return (
    <div className="chat">
      <div
        className="chat__scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Conversation"
        aria-live="off"
      >
        <div className={`chat__column${conversation ? '' : ' chat__column--center'}`}>
          {!conversation ? (
            <Landing
              hasProfile={app.state.profiles.length > 0}
              hasActiveProfile={Boolean(profile)}
              connected={connectionState === 'connected'}
              untested={connectionState === 'untested'}
              stale={connectionState === 'stale'}
              onOpenSettings={onOpenSettings}
            />
          ) : messageCount === 0 ? (
            profile ? (
              <Welcome profile={profile} onPickStarter={pickStarter} />
            ) : (
              <div className="hero">
                <span className="hero__mark" aria-hidden="true">
                  <Icon name="alert" size={22} />
                </span>
                <h2 className="hero__title">This conversation has no connection</h2>
                <p className="hero__lead">
                  Select a connection profile in the settings, or create a new one, to continue.
                </p>
                <button type="button" className="button button--primary" onClick={onOpenSettings}>
                  <Icon name="settings" size={14} />
                  Open connection settings
                </button>
              </div>
            )
          ) : (
            <div className="chat__messages">
              {messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  isLast={message.id === lastId}
                  disabled={pending}
                  onToolApproval={onToolApproval}
                  onCopy={onCopy}
                  onEdit={onEdit}
                  onRetry={onRetry}
                  onResend={onResend}
                  onRegenerate={onRegenerate}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {showJump ? (
        <button type="button" className="jump-latest" onClick={() => scrollToBottom(true)}>
          <Icon name="arrow-down" size={13} />
          Jump to latest
        </button>
      ) : null}

      <div className="chat__composer">
        <div className="chat__composer-inner">
          {conversation && missingProfile ? (
            <div className="notice notice--warning chat__notice" role="status">
              <Icon name="alert" size={14} />
              <span>
                This conversation has no connection profile. Select or create one to keep chatting.
              </span>
              <button type="button" className="button button--small" onClick={onOpenSettings}>
                Open settings
              </button>
            </div>
          ) : conversation && connectionState === 'failed' ? (
            <div className="notice notice--warning chat__notice" role="status">
              <Icon name="alert" size={14} />
              <span>The last connection test failed, so a message will probably fail too.</span>
              <button type="button" className="button button--small" onClick={onOpenSettings}>
                Review connection
              </button>
            </div>
          ) : null}

          {conversation && profile && profileTools ? (
            <details className="conversation-tools">
              <summary>Conversation tools and privacy</summary>
              <p className="field__hint">Profile settings remain the outer allowlist; this conversation can only disable tools, select a subset, and tighten budgets.</p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={profileTools.enabled && conversation.toolSettings?.enabled !== false}
                  disabled={!profileTools.enabled || availableToolIds.length === 0}
                  onChange={(event) => updateConversationToolSettings({ enabled: event.target.checked })}
                />
                <span>Use the profile's enabled tools in this conversation</span>
              </label>
              {availableToolIds.length > 0 ? (
                <fieldset className="conversation-tools__list">
                  <legend>Allowed subset</legend>
                  {availableToolIds.map((id) => (
                    <label className="checkbox" key={id}>
                      <input
                        type="checkbox"
                        checked={selectedToolIds.includes(id)}
                        onChange={(event) => {
                          const current = conversation.toolSettings?.toolIds ?? availableToolIds;
                          const next = event.target.checked ? [...new Set([...current, id])] : current.filter((entry) => entry !== id);
                          updateConversationToolSettings({ toolIds: next });
                        }}
                      />
                      <span>{id}</span>
                    </label>
                  ))}
                </fieldset>
              ) : <p className="text-subtle">No tools are in the profile allowlist.</p>}
              <label className="field">
                <span className="field__label">Maximum tool rounds in this conversation</span>
                <input
                  type="number"
                  min={1}
                  max={profileTools.limits.maxRounds}
                  value={conversation.toolSettings?.maxRounds ?? profileTools.limits.maxRounds}
                  disabled={!profileTools.enabled}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) updateConversationToolSettings({ maxRounds: Math.max(1, Math.min(profileTools.limits.maxRounds, Math.floor(value))) });
                  }}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={conversation.toolSettings?.historyPersistence ?? profileTools.historyPersistence}
                  disabled={!profileTools.enabled || (profileTools.web.provider === 'brave' && !profileTools.web.storageRightsConfirmed)}
                  onChange={(event) => updateConversationToolSettings({ historyPersistence: event.target.checked })}
                />
                <span>Persist tool history for this conversation
                  <span className="field__hint" style={{ display: 'block' }}>Off by default. File contents and credentials are never persisted. Brave result history also requires explicit storage-rights confirmation.</span>
                </span>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={conversation.toolSettings?.selectionRecovery === true}
                  disabled={!profileTools.enabled || availableToolIds.length === 0}
                  onChange={(event) => updateConversationToolSettings({ selectionRecovery: event.target.checked })}
                />
                <span>Allow one corrective round when the model answers without considering the tools
                  <span className="field__hint" style={{ display: 'block' }}>Off by default. When on, a first plain-text answer spends at most one extra model round asking whether a listed tool is actually needed; the model may still answer directly, and no tool runs without its normal permissions or approval.</span>
                </span>
              </label>
            </details>
          ) : null}

          {canUploadFiles && conversation ? (
            <div className="conversation-uploads" aria-label="Conversation uploads">
              <input
                ref={uploadInputRef}
                className="visually-hidden"
                type="file"
                multiple
                accept=".txt,.md,.markdown,.csv,.json,.pdf,.docx"
                onChange={(event) => void handleUpload(event)}
              />
              <div className="row row--between">
                <button type="button" className="button button--small" disabled={uploading || pending || uploadedFiles.length >= 16} onClick={() => uploadInputRef.current?.click()}>
                  <Icon name="plus" size={13} /> {uploading ? 'Uploading…' : 'Upload a file'}
                </button>
                <span className="field__hint">Up to 4 MiB each; kept in proxy memory for at most one hour.</span>
              </div>
              {uploadedFiles.length > 0 ? (
                <ul className="conversation-uploads__list">
                  {uploadedFiles.map((file) => <li key={file.id}><strong>{file.name}</strong><span>{file.size.toLocaleString()} bytes · {file.extractedCharacters.toLocaleString()} extracted characters{file.truncated ? ' · truncated' : ''}</span></li>)}
                </ul>
              ) : null}
              {uploadError ? <p className="field__error" role="alert">{uploadError}</p> : null}
            </div>
          ) : null}

          <Composer
            value={draft}
            onChange={setDraft}
            onSend={onSend}
            onCancel={onCancel}
            pending={pending}
            disabled={missingProfile}
            placeholder={placeholder}
            inputRef={composerRef}
          />

          <div className="chat__footnote">
            <span>
              {profile
                ? `Sending to ${profile.modelId || 'the first model of the server'} through the local proxy.`
                : 'No model connection selected.'}
            </span>
            <span>Answers can be wrong — check code and facts before relying on them.</span>
          </div>
        </div>
      </div>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
