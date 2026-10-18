/**
 * A single chat message.
 *
 * Handles the four request states the UI has to distinguish: pending,
 * complete, cancelled and failed. Token usage is only rendered when the
 * server actually returned it.
 */

import { useState } from 'react';

import { describeErrorKind } from '../../shared/api/errors';
import type { ChatMessage } from '../../shared/domain';
import { formatTimestamp } from '../lib/id';
import { Markdown } from './Markdown';
import { Icon } from './ui';

export interface MessageItemProps {
  message: ChatMessage;
  disabled?: boolean;
  onCopy?: (message: ChatMessage) => void;
  onEdit?: (messageId: string, content: string) => void;
  onRetry?: (messageId: string) => void;
  onResend?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
}

function usageLabel(message: ChatMessage): string | null {
  const usage = message.usage;
  if (!usage) return null;
  const parts: string[] = [];
  if (typeof usage.prompt_tokens === 'number') parts.push(`${usage.prompt_tokens} prompt`);
  if (typeof usage.completion_tokens === 'number') parts.push(`${usage.completion_tokens} completion`);
  if (typeof usage.total_tokens === 'number') parts.push(`${usage.total_tokens} total`);
  if (parts.length === 0) return null;
  return `${parts.join(' · ')} tokens`;
}

export function MessageItem({
  message,
  disabled,
  onCopy,
  onEdit,
  onRetry,
  onResend,
  onRegenerate,
}: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);

  const isUser = message.role === 'user';
  const usage = usageLabel(message);

  const handleCopy = async () => {
    if (!onCopy) return;
    await onCopy(message);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const submitEdit = () => {
    const value = draft.trim();
    if (!value) return;
    setEditing(false);
    onEdit?.(message.id, value);
  };

  return (
    <article
      className={`message message--${message.role} message--${message.status}`}
      data-testid={`message-${message.role}`}
      data-status={message.status}
    >
      <div className="message__avatar" aria-hidden="true">
        {isUser ? 'You' : 'AI'}
      </div>

      <div className="message__body">
        <div className="message__meta">
          <span>{isUser ? 'You' : 'Assistant'}</span>
          {!isUser && message.model ? <span>· {message.model}</span> : null}
          <span>· {formatTimestamp(message.createdAt)}</span>
          {usage ? <span className="usage-chip">{usage}</span> : null}
        </div>

        {message.status === 'pending' ? (
          <p className="text-muted">
            <span className="loading-dots">Generating</span>
          </p>
        ) : null}

        {message.status === 'error' ? (
          <div className="message__error" role="alert">
            <strong>
              {describeErrorKind(message.errorKind ?? 'unknown')}
            </strong>
            <p>{message.errorMessage}</p>
            {message.errorHint ? <p className="text-subtle">{message.errorHint}</p> : null}
          </div>
        ) : null}

        {message.status === 'cancelled' ? (
          <div className="notice notice--warning">
            <strong>Request cancelled</strong>
            The request was stopped before the model finished responding.
          </div>
        ) : null}

        {message.status !== 'pending' && message.status !== 'error' ? (
          isUser ? (
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{message.content}</p>
          ) : (
            <Markdown content={message.content} />
          )
        ) : null}

        {message.reasoning ? (
          <details className="text-subtle" style={{ marginTop: 8 }}>
            <summary>Reasoning trace</summary>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{message.reasoning}</pre>
          </details>
        ) : null}

        {editing ? (
          <div className="stack" style={{ marginTop: 12 }}>
            <label className="field__label" htmlFor={`edit-${message.id}`}>
              Edit message
            </label>
            <textarea
              id={`edit-${message.id}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submitEdit();
                }
                if (event.key === 'Escape') {
                  setEditing(false);
                  setDraft(message.content);
                }
              }}
            />
            <div className="row">
              <button type="button" className="button button--primary button--small" onClick={submitEdit}>
                Save and resend
              </button>
              <button
                type="button"
                className="button button--small"
                onClick={() => {
                  setEditing(false);
                  setDraft(message.content);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {message.status !== 'pending' ? (
          <div className="message__actions">
            <button type="button" className="button button--ghost button--small" onClick={() => void handleCopy()}>
              <Icon name={copied ? 'check' : 'copy'} size={13} />
              {copied ? 'Copied' : 'Copy'}
            </button>

            {isUser && onEdit && !editing ? (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => {
                  setDraft(message.content);
                  setEditing(true);
                }}
                disabled={disabled}
              >
                <Icon name="edit" size={13} />
                Edit
              </button>
            ) : null}

            {isUser && onResend && !editing ? (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => onResend?.(message.id)}
                disabled={disabled}
                title="Send this message again"
              >
                <Icon name="refresh" size={13} />
                Resend
              </button>
            ) : null}

            {!isUser && (message.status === 'error' || message.status === 'cancelled') && onRetry ? (
              <button
                type="button"
                className="button button--small"
                onClick={() => onRetry?.(message.id)}
                disabled={disabled}
              >
                <Icon name="refresh" size={13} />
                Retry
              </button>
            ) : null}

            {!isUser && message.status === 'complete' && onRegenerate ? (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => onRegenerate?.(message.id)}
                disabled={disabled}
              >
                <Icon name="refresh" size={13} />
                Regenerate
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
