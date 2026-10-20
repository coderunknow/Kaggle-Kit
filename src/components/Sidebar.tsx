/**
 * Conversation sidebar.
 *
 * Groups the history by the day of the last activity, filters by title and
 * message text, renames inline and deletes only after a second, explicit
 * click. The footer shows the active connection instead of hiding it in a
 * settings dialog.
 */

import { useEffect, useMemo, useState } from 'react';

import { effectiveProfileTarget, resolveConnectionView } from '../../shared/connection';
import type { Conversation } from '../../shared/domain';
import { APP_VERSION } from '../../shared/version';
import { formatTimestamp } from '../lib/id';
import { useApp } from '../state/AppProvider';
import { Badge, Icon, StatusDot, type StatusTone } from './ui';

export interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onNavigate: () => void;
  onOpenSettings: () => void;
  onNewConversation: () => void;
}

interface ConversationGroup {
  label: string;
  conversations: Conversation[];
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function groupConversations(
  conversations: Conversation[],
  now = new Date(),
): ConversationGroup[] {
  const today = startOfDay(now);
  const yesterday = today - 24 * 60 * 60 * 1000;
  const week = today - 7 * 24 * 60 * 60 * 1000;

  const groups: ConversationGroup[] = [
    { label: 'Today', conversations: [] },
    { label: 'Yesterday', conversations: [] },
    { label: 'Previous 7 days', conversations: [] },
    { label: 'Older', conversations: [] },
  ];

  const sorted = [...conversations].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt) || 0;
    const rightTime = Date.parse(right.updatedAt) || 0;
    return rightTime - leftTime;
  });

  for (const conversation of sorted) {
    const time = Date.parse(conversation.updatedAt) || 0;
    if (time >= today) groups[0]!.conversations.push(conversation);
    else if (time >= yesterday) groups[1]!.conversations.push(conversation);
    else if (time >= week) groups[2]!.conversations.push(conversation);
    else groups[3]!.conversations.push(conversation);
  }

  return groups.filter((group) => group.conversations.length > 0);
}

/** Host name of a base URL, or the raw value when it cannot be parsed. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function Sidebar({
  open,
  onClose,
  onNavigate,
  onOpenSettings,
  onNewConversation,
}: SidebarProps) {
  const app = useApp();
  const { conversations, preferences, profiles } = app.state;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const activeProfile = profiles.find((profile) => profile.id === preferences.activeProfileId);
  const connection = resolveConnectionView(app.state, activeProfile);

  useEffect(() => {
    if (!confirmingId) return;
    const timer = window.setTimeout(() => setConfirmingId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((conversation) => {
      if (conversation.title.toLowerCase().includes(needle)) return true;
      return conversation.messages.some((message) =>
        message.content.toLowerCase().includes(needle),
      );
    });
  }, [conversations, query]);

  const groups = useMemo(() => groupConversations(filtered), [filtered]);

  const startRename = (conversation: Conversation) => {
    setConfirmingId(null);
    setRenamingId(conversation.id);
    setDraftTitle(conversation.title);
  };

  const commitRename = (conversationId: string) => {
    const title = draftTitle.trim();
    if (title) app.renameConversation(conversationId, title);
    setRenamingId(null);
  };

  const statusTone: StatusTone = connection.tone;
  const statusText = connection.label.toLowerCase();

  return (
    <>
      {open ? (
        <button
          type="button"
          className="sidebar__scrim"
          aria-label="Close the conversations sidebar"
          tabIndex={-1}
          onClick={onClose}
        />
      ) : null}

      <aside
        id="conversation-sidebar"
        className={`sidebar${open ? ' sidebar--open' : ''}`}
        aria-label="Conversations"
        data-open={open ? 'true' : 'false'}
      >
        <div className="sidebar__brand">
          <span className="brand-mark" aria-hidden="true">
            KK
          </span>
          <span className="brand-text">
            <span className="brand-text__name">Kaggle-Kit</span>
            <span className="brand-text__sub">local model chat</span>
          </span>
          <button
            type="button"
            className="button button--ghost button--icon sidebar__close"
            aria-label="Close the conversations sidebar"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <button
          type="button"
          className="button button--primary button--block sidebar__new"
          onClick={() => {
            onNewConversation();
            onNavigate();
          }}
        >
          <Icon name="plus" size={15} />
          New conversation
          <kbd className="sidebar__kbd" aria-hidden="true">
            Alt ⇧ N
          </kbd>
        </button>

        {conversations.length >= 3 ? (
          <div className="sidebar__search">
            <Icon name="search" size={14} className="sidebar__search-icon" />
            <label className="visually-hidden" htmlFor="conversation-search">
              Search conversations
            </label>
            <input
              id="conversation-search"
              type="search"
              value={query}
              placeholder="Search conversations"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                className="button button--ghost button--icon sidebar__search-clear"
                aria-label="Clear the search"
                onClick={() => setQuery('')}
              >
                <Icon name="close" size={13} />
              </button>
            ) : null}
          </div>
        ) : null}

        <nav className="sidebar__nav" aria-label="Conversation history">
          {conversations.length === 0 ? (
            <p className="sidebar__empty">
              No conversations yet. Start one to talk to the model.
            </p>
          ) : filtered.length === 0 ? (
            <p className="sidebar__empty">
              No conversation matches “{query}”.
              <button type="button" className="button button--ghost button--small" onClick={() => setQuery('')}>
                Clear the search
              </button>
            </p>
          ) : (
            groups.map((group) => (
              <div className="conv-group" key={group.label}>
                <span className="conv-group__label" id={`group-${group.label.replace(/\s+/g, '-')}`}>
                  {group.label}
                </span>
                <ul
                  className="conv-list"
                  aria-labelledby={`group-${group.label.replace(/\s+/g, '-')}`}
                >
                  {group.conversations.map((conversation) => {
                    const isActive = conversation.id === preferences.activeConversationId;
                    const isRenaming = renamingId === conversation.id;
                    const isConfirming = confirmingId === conversation.id;
                    const messageCount = conversation.messages.length;

                    return (
                      <li key={conversation.id} className="conv">
                        {isRenaming ? (
                          <div className="conv__rename">
                            <label className="visually-hidden" htmlFor={`rename-${conversation.id}`}>
                              Conversation title
                            </label>
                            <input
                              id={`rename-${conversation.id}`}
                              type="text"
                              value={draftTitle}
                              autoFocus
                              onChange={(event) => setDraftTitle(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') commitRename(conversation.id);
                                if (event.key === 'Escape') setRenamingId(null);
                              }}
                              onBlur={() => commitRename(conversation.id)}
                            />
                          </div>
                        ) : (
                          <div className="conv__row" data-active={isActive ? 'true' : undefined}>
                            <button
                              type="button"
                              className="conv__select"
                              aria-current={isActive ? 'true' : undefined}
                              onClick={() => {
                                app.selectConversation(conversation.id);
                                onNavigate();
                              }}
                            >
                              <span className="conv__title">{conversation.title}</span>
                              <span className="conv__meta">
                                {messageCount} message{messageCount === 1 ? '' : 's'} ·{' '}
                                {formatTimestamp(conversation.updatedAt)}
                              </span>
                            </button>

                            <div className="conv__actions">
                              <button
                                type="button"
                                className="button button--ghost button--icon button--small"
                                aria-label={`Rename ${conversation.title}`}
                                title="Rename conversation"
                                onClick={() => startRename(conversation)}
                              >
                                <Icon name="edit" size={13} />
                              </button>
                              {isConfirming ? (
                                <button
                                  type="button"
                                  className="button button--danger button--small"
                                  aria-label={`Confirm delete ${conversation.title}`}
                                  onClick={() => {
                                    app.deleteConversation(conversation.id);
                                    setConfirmingId(null);
                                    onNavigate();
                                  }}
                                >
                                  Delete
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="button button--ghost button--icon button--small"
                                  aria-label={`Delete ${conversation.title}`}
                                  title="Delete conversation"
                                  onClick={() => setConfirmingId(conversation.id)}
                                >
                                  <Icon name="trash" size={13} />
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </nav>

        <div className="sidebar__footer">
          {activeProfile ? (
            <button
              type="button"
              className="connection-card"
              onClick={onOpenSettings}
              aria-label={`Connection settings of ${activeProfile.name}`}
            >
              <span className="connection-card__top">
                <StatusDot tone={statusTone} />
                <span className="connection-card__name">{activeProfile.name}</span>
                <span className="connection-card__status">{statusText}</span>
              </span>
              <span className="connection-card__model">
                {hostOf(effectiveProfileTarget(activeProfile).baseUrl)} ·{' '}
                {activeProfile.modelId || 'first model of the server'}
              </span>
              <span className="connection-card__badges">
                <Badge tone={activeProfile.credentialStorage === 'session' ? 'neutral' : 'info'}>
                  {activeProfile.credentialStorage === 'session'
                    ? 'key in memory'
                    : activeProfile.credentialStorage === 'server'
                      ? 'key on proxy'
                      : 'key in browser'}
                </Badge>
                {activeProfile.defaultParams.stream ? <Badge tone="neutral">streaming on</Badge> : null}
              </span>
            </button>
          ) : (
            <button type="button" className="connection-card connection-card--empty" onClick={onOpenSettings}>
              <span className="connection-card__top">
                <StatusDot tone="warning" />
                <span className="connection-card__name">No connection</span>
              </span>
              <span className="connection-card__model">Add a profile to start chatting</span>
            </button>
          )}

          <div className="sidebar__footer-row">
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={onOpenSettings}
            >
              <Icon name="settings" size={14} />
              Settings
            </button>
            <span className="sidebar__version">v{APP_VERSION}</span>
          </div>
        </div>
      </aside>
    </>
  );
}
