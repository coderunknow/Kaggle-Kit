/**
 * Sidebar with the conversation list and the active profile summary.
 */

import { useState } from 'react';

import { formatTimestamp } from '../lib/id';
import { useApp } from '../state/AppProvider';
import { Badge, Icon } from './ui';

export interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ open, onClose, onOpenSettings }: SidebarProps) {
  const app = useApp();
  const { conversations, preferences, profiles } = app.state;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  const activeProfile = profiles.find((profile) => profile.id === preferences.activeProfileId);

  const startRename = (conversationId: string, title: string) => {
    setRenamingId(conversationId);
    setDraftTitle(title);
  };

  const commitRename = (conversationId: string) => {
    const title = draftTitle.trim();
    if (title) app.renameConversation(conversationId, title);
    setRenamingId(null);
  };

  return (
    <>
      {open ? (
        <button
          type="button"
          className="sidebar__scrim"
          aria-label="Close the sidebar"
          onClick={onClose}
        />
      ) : null}

      <aside className={`sidebar${open ? ' sidebar--open' : ''}`} aria-label="Conversations">
        <button
          type="button"
          className="button button--primary button--block"
          onClick={() => {
            app.newConversation();
            onClose();
          }}
        >
          <Icon name="plus" size={15} />
          New conversation
        </button>

        <div className="sidebar__section-title">
          <span>Conversations</span>
          <span>{conversations.length}</span>
        </div>

        {conversations.length === 0 ? (
          <p className="text-subtle" style={{ padding: '0 8px' }}>
            No conversations yet. Start one to talk to the model.
          </p>
        ) : (
          <ul className="sidebar__list sidebar__list--conversations">
            {conversations.map((conversation) => {
              const isActive = conversation.id === preferences.activeConversationId;
              const isRenaming = renamingId === conversation.id;

              return (
                <li key={conversation.id}>
                  {isRenaming ? (
                    <div className="stack stack--tight" style={{ padding: 4 }}>
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
                    <div
                      className="sidebar__item"
                      aria-current={isActive}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        app.selectConversation(conversation.id);
                        onClose();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          app.selectConversation(conversation.id);
                          onClose();
                        }
                      }}
                    >
                      <div className="sidebar__item-main">
                        <span className="sidebar__item-title">{conversation.title}</span>
                        <span className="sidebar__item-meta">
                          {conversation.messages.length} message
                          {conversation.messages.length === 1 ? '' : 's'} ·{' '}
                          {formatTimestamp(conversation.updatedAt)}
                        </span>
                      </div>

                      <div className="sidebar__item-actions">
                        <button
                          type="button"
                          className="button button--ghost button--icon button--small"
                          aria-label={`Rename ${conversation.title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            startRename(conversation.id, conversation.title);
                          }}
                        >
                          <Icon name="edit" size={13} />
                        </button>
                        <button
                          type="button"
                          className="button button--ghost button--icon button--small"
                          aria-label={`Delete ${conversation.title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            app.deleteConversation(conversation.id);
                          }}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="sidebar__footer">
          <div className="sidebar__section-title">
            <span>Active profile</span>
          </div>
          {activeProfile ? (
            <button
              type="button"
              className="sidebar__item"
              onClick={onOpenSettings}
              aria-label={`Settings of the active profile ${activeProfile.name}`}
            >
              <div className="sidebar__item-main">
                <span className="sidebar__item-title">{activeProfile.name}</span>
                <span className="sidebar__item-meta">{activeProfile.baseUrl}</span>
              </div>
              <Badge tone={activeProfile.modelId ? 'ok' : 'warning'}>
                {activeProfile.modelId ? 'model set' : 'no model'}
              </Badge>
            </button>
          ) : (
            <p className="text-subtle">No profile selected.</p>
          )}

          <button type="button" className="button button--block" onClick={onOpenSettings}>
            <Icon name="settings" size={15} />
            Settings
          </button>
        </div>
      </aside>
    </>
  );
}
