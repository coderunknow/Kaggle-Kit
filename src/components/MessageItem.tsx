/**
 * One message of the conversation.
 *
 * The row is memoised: while an answer streams only the message that changes
 * is re-rendered, not the whole history. Every action reports what really
 * happened (a failed copy says so) and answers that failed or were cancelled
 * are never presented as complete.
 */

import { lazy, memo, Suspense, useState } from 'react';

import { describeErrorKind } from '../../shared/api/errors';
import type { ChatMessage } from '../../shared/domain';
import type { SourceCitation, ToolTraceRecord } from '../../shared/tools/types';
import { formatMessageTime } from '../lib/id';
import { Icon } from './ui';

// react-markdown + highlighting is the heaviest client dependency; it loads
// as its own chunk on the first assistant message instead of blocking the
// initial chat paint. The fallback renders the same text unformatted.
const Markdown = lazy(() =>
  import('./Markdown').then((module) => ({ default: module.Markdown })),
);

export interface MessageItemProps {
  message: ChatMessage;
  isLast: boolean;
  /** A request is running for this conversation. */
  disabled: boolean;
  onToolApproval: (messageId: string, approvalId: string, approved: boolean) => void;
  onCopy: (message: ChatMessage) => Promise<boolean>;
  onEdit: (messageId: string, content: string) => void;
  onRetry: (messageId: string) => void;
  onResend: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

function usageLabel(message: ChatMessage): string | null {
  const usage = message.usage;
  if (!usage) return null;
  const parts: string[] = [];
  if (typeof usage.prompt_tokens === 'number') parts.push(`in ${usage.prompt_tokens}`);
  if (typeof usage.completion_tokens === 'number') parts.push(`out ${usage.completion_tokens}`);
  if (parts.length === 0 && typeof usage.total_tokens === 'number') {
    parts.push(`${usage.total_tokens} tokens`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function stopReasonLabel(message: ChatMessage): string | null {
  if (message.role !== 'assistant' || !message.finishReason) return null;
  if (message.finishReason === 'length') {
    return 'The answer stopped because the maximum output tokens were reached.';
  }
  if (message.finishReason === 'content_filter') {
    return 'The server stopped the answer with a content filter.';
  }
  return null;
}

const TOOL_STATUS_LABELS: Record<ToolTraceRecord['status'], string> = {
  requested: 'Requested',
  awaiting_approval: 'Waiting for your approval',
  approved: 'Approved',
  running: 'Running',
  succeeded: 'Completed',
  failed: 'Failed',
  denied: 'Denied; not run',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

function CitationList({ citations }: { citations: SourceCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <section className="source-citations" aria-label="Retrieved sources">
      <strong>Retrieved sources</strong>
      <ol>
        {citations.map((citation) => (
          <li key={citation.url}>
            <a href={citation.url} target="_blank" rel="noopener noreferrer">
              {citation.title || citation.publisher || citation.url}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ToolTimeline({
  message,
  disabled,
  onApproval,
}: {
  message: ChatMessage;
  disabled: boolean;
  onApproval: MessageItemProps['onToolApproval'];
}) {
  const trace = message.toolTrace ?? [];
  if (trace.length === 0 && !message.sourceCitations?.length) return null;
  return (
    <div className="tool-timeline">
      {trace.length > 0 ? (
        <details open={message.status === 'pending' && trace.some((entry) => entry.status === 'awaiting_approval')}>
          <summary>Tool activity ({trace.length})</summary>
          <ol className="tool-timeline__list">
            {trace.map((entry) => {
              const canApprove = entry.status === 'awaiting_approval' && Boolean(entry.approvalId && message.toolJobId);
              return (
                <li key={entry.id} className="tool-timeline__item">
                  <div className="tool-timeline__heading">
                    <strong>{entry.toolName}</strong>
                    <span role="status">{TOOL_STATUS_LABELS[entry.status]}</span>
                  </div>
                  {entry.target ? <code className="tool-timeline__target">{entry.target}</code> : null}
                  {entry.resultSummary ? <p>{entry.resultSummary}</p> : null}
                  {entry.error ? <p className="field__error">{entry.error}</p> : null}
                  {Object.keys(entry.safeArguments).length > 0 ? (
                    <details className="tool-timeline__arguments" open={canApprove}>
                      <summary>Review bounded arguments</summary>
                      <pre>{JSON.stringify(entry.safeArguments, null, 2)}</pre>
                    </details>
                  ) : null}
                  {canApprove ? (
                    <div className="tool-timeline__approval" aria-label={`Approval for ${entry.toolName}`}>
                      <p>This exact operation has not run. Approving authorizes this call only.</p>
                      <div className="row">
                        <button type="button" className="button button--primary button--small" disabled={disabled && !canApprove} onClick={() => onApproval(message.id, entry.approvalId!, true)}>
                          Approve once
                        </button>
                        <button type="button" className="button button--small button--danger" disabled={disabled && !canApprove} onClick={() => onApproval(message.id, entry.approvalId!, false)}>
                          Deny
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
      <CitationList citations={message.sourceCitations ?? []} />
    </div>
  );
}

function MessageItemImpl({
  message,
  isLast,
  disabled,
  onToolApproval,
  onCopy,
  onEdit,
  onRetry,
  onResend,
  onRegenerate,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  const isPending = message.status === 'pending';
  const isError = message.status === 'error';
  const isCancelled = message.status === 'cancelled';
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [editError, setEditError] = useState<string | null>(null);

  const usage = usageLabel(message);
  const stopReason = stopReasonLabel(message);
  const hasContent = message.content.trim().length > 0;

  const copy = async () => {
    const copied = await onCopy(message);
    setCopyState(copied ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 2000);
  };

  const startEditing = () => {
    setDraft(message.content);
    setEditError(null);
    setEditing(true);
  };

  const submitEdit = () => {
    if (!draft.trim()) {
      setEditError('The message must not be empty. Cancel to keep the original.');
      return;
    }
    setEditing(false);
    onEdit(message.id, draft);
  };

  const classes = [
    'msg',
    isUser ? 'msg--user' : 'msg--assistant',
    isError ? 'msg--error' : '',
    isCancelled ? 'msg--cancelled' : '',
    isPending ? 'msg--pending' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={classes} aria-busy={isPending || undefined} data-status={message.status}>
      <div className="msg__avatar" aria-hidden="true">
        {isUser ? 'YOU' : <Icon name="sparkle" size={14} />}
      </div>

      <div className="msg__body">
        <div className="msg__meta">
          <span className="msg__author">{isUser ? 'You' : 'Assistant'}</span>
          {!isUser && message.model ? <span className="msg__model">{message.model}</span> : null}
          <time className="msg__time" dateTime={message.createdAt}>
            {formatMessageTime(message.createdAt)}
          </time>
          {usage ? (
            <span className="usage-chip" title="Token counts reported by the model server">
              {usage}
            </span>
          ) : null}
          {!isUser && message.transport === 'stream' ? (
            <span className="msg__flag" title="The answer arrived as a server-sent event stream">
              streamed
            </span>
          ) : null}
        </div>

        <div className="msg__content">
          {editing ? (
            <div className="msg__editor">
              <label className="visually-hidden" htmlFor={`edit-${message.id}`}>
                Edit the message
              </label>
              <textarea
                id={`edit-${message.id}`}
                value={draft}
                autoFocus
                onChange={(event) => {
                  setDraft(event.target.value);
                  setEditError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setEditing(false);
                    return;
                  }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submitEdit();
                  }
                }}
                aria-invalid={Boolean(editError)}
                aria-describedby={editError ? `edit-error-${message.id}` : undefined}
              />
              {editError ? (
                <span className="field__error" id={`edit-error-${message.id}`} role="alert">
                  {editError}
                </span>
              ) : null}
              <div className="row">
                <button type="button" className="button button--primary button--small" onClick={submitEdit}>
                  Save and resend
                </button>
                <button type="button" className="button button--small" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <span className="text-subtle">Ctrl/⌘ + Enter to resend</span>
              </div>
            </div>
          ) : isUser ? (
            <p className="msg__text">{message.content}</p>
          ) : hasContent ? (
            <Suspense fallback={<p className="msg__text">{message.content}</p>}>
              <Markdown content={message.content} streaming={isPending} />
            </Suspense>
          ) : null}

          {isPending ? (
            <p className="msg__generating">
              <span className="typing" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {hasContent ? 'Still writing…' : 'Waiting for the first token…'}
            </p>
          ) : null}

          {!isPending && !isUser && !hasContent && message.status === 'complete' ? (
            <p className="msg__empty">
              The model returned an empty answer. Try again, raise the maximum output tokens in the
              inference settings, or check the server log.
            </p>
          ) : null}

          {isError ? (
            <div className="msg__error" role="alert">
              <div className="msg__error-head">
                <Icon name="alert" size={14} />
                <strong>{describeErrorKind(message.errorKind ?? 'unknown')}</strong>
              </div>
              <p>{message.errorMessage ?? 'The request failed.'}</p>
              {message.errorHint ? <p className="msg__error-hint">{message.errorHint}</p> : null}
              {hasContent ? (
                <p className="msg__error-hint">
                  The text above is the part that arrived before the failure.
                </p>
              ) : null}
            </div>
          ) : null}

          {isCancelled ? (
            <div className="msg__notice">
              <Icon name="stop" size={12} />
              <span>
                <strong>Request cancelled.</strong> The answer was stopped before the model
                finished.
              </span>
            </div>
          ) : null}

          {message.toolNote ? (
            <p className="msg__fallback" role="status">
              <Icon name="info" size={12} />
              {message.toolNote}
            </p>
          ) : null}

          {message.transientToolContent ? (
            <p className="msg__fallback" role="status">
              <Icon name="info" size={12} />
              This answer and later assistant replies based on it are visible in this session only. They will not be saved or exported unless you confirm Brave retention rights and enable tool-history persistence.
            </p>
          ) : null}

          {message.streamFellBack && message.status === 'complete' ? (
            <p className="msg__fallback">
              <Icon name="info" size={12} />
              The proxy had not verified streaming for this endpoint, so the answer was fetched with
              a regular request. Run “Verify streaming support” in the inference settings.
            </p>
          ) : null}

          {stopReason ? (
            <p className="msg__notice">
              <Icon name="info" size={12} />
              <span>{stopReason}</span>
            </p>
          ) : null}
        </div>

        {message.reasoning ? (
          <details className="msg__reasoning">
            <summary>Reasoning</summary>
            <pre>{message.reasoning}</pre>
          </details>
        ) : null}

        <ToolTimeline message={message} disabled={disabled} onApproval={onToolApproval} />

        {!editing ? (
          <div className="msg__actions">
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => void copy()}
              aria-label={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy message'}
              title={copyState === 'failed' ? 'The browser did not allow the copy.' : 'Copy the text of this message'}
            >
              <Icon name={copyState === 'copied' ? 'check' : copyState === 'failed' ? 'alert' : 'copy'} size={13} />
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
            </button>

            {isUser ? (
              <>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={startEditing}
                  disabled={disabled}
                >
                  <Icon name="edit" size={13} />
                  Edit
                </button>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => onResend(message.id)}
                  disabled={disabled}
                  title="Send this message again and drop everything after it"
                >
                  <Icon name="refresh" size={13} />
                  Resend
                </button>
              </>
            ) : (
              <>
                {(isError || isCancelled) && (
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => onRetry(message.id)}
                    disabled={disabled}
                  >
                    <Icon name="refresh" size={13} />
                    Retry
                  </button>
                )}
                {isLast && message.status === 'complete' && !disabled ? (
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => onRegenerate(message.id)}
                    title="Ask the model for another answer"
                  >
                    <Icon name="refresh" size={13} />
                    Regenerate
                  </button>
                ) : null}
              </>
            )}

            <span className="visually-hidden" role="status" aria-live="polite">
              {copyState === 'copied'
                ? 'The message was copied to the clipboard.'
                : copyState === 'failed'
                  ? 'The browser did not allow the copy.'
                  : ''}
            </span>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export const MessageItem = memo(
  MessageItemImpl,
  (previous, next) =>
    previous.message === next.message &&
    previous.isLast === next.isLast &&
    previous.disabled === next.disabled,
);
