/**
 * The chat surface: message list plus composer.
 */

import { useEffect, useRef } from 'react';

import type { ApiProfile, ChatMessage, Conversation } from '../../shared/domain';
import { Composer } from './Composer';
import { MessageItem } from './MessageItem';

export interface ChatViewProps {
  conversation: Conversation | undefined;
  profile: ApiProfile | undefined;
  pending: boolean;
  onSend: (content: string) => void;
  onCancel: () => void;
  onCopy: (message: ChatMessage) => void;
  onEdit: (messageId: string, content: string) => void;
  onRetry: (messageId: string) => void;
  onResend: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onNewConversation: () => void;
  onOpenSettings: () => void;
}

export function ChatView({
  conversation,
  profile,
  pending,
  onSend,
  onCancel,
  onCopy,
  onEdit,
  onRetry,
  onResend,
  onRegenerate,
  onNewConversation,
  onOpenSettings,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageCount = conversation?.messages.length ?? 0;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messageCount, conversation?.messages]);

  if (!conversation) {
    return (
      <div className="chat">
        <div className="chat__scroll">
          <div className="chat__empty">
            <h2>Start a conversation</h2>
            <p>
              Pick the connection profile that points at your Kaggle llama.cpp server, then send a
              message. Nothing is sent anywhere until you type.
            </p>
            <ul>
              <li>Configure the base URL and API key of your server in Settings.</li>
              <li>Run the connection test to verify the endpoint really answers.</li>
              <li>Send a message and the model response appears here.</li>
            </ul>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button type="button" className="button button--primary" onClick={onNewConversation}>
                Start a conversation
              </button>
              <button type="button" className="button" onClick={onOpenSettings}>
                Open settings
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const missingProfile = !profile;

  return (
    <div className="chat">
      <div className="chat__scroll" ref={scrollRef}>
        <div className="chat__inner">
          {conversation.messages.length === 0 ? (
            <div className="chat__empty">
              <h2>New conversation</h2>
              <p>
                {profile
                  ? `Sending to ${profile.modelId || 'the first available model'} via ${profile.baseUrl}.`
                  : 'No connection profile is selected yet.'}
              </p>
            </div>
          ) : null}

          {missingProfile ? (
            <div className="notice notice--warning">
              <strong>No connection profile</strong>
              Select or create a profile in Settings before sending a message.
            </div>
          ) : null}

          {conversation.messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              disabled={pending}
              onCopy={onCopy}
              onEdit={onEdit}
              onRetry={onRetry}
              onResend={onResend}
              onRegenerate={onRegenerate}
            />
          ))}
        </div>
      </div>

      <Composer
        onSend={onSend}
        onCancel={onCancel}
        pending={pending}
        disabled={missingProfile}
        placeholder={
          missingProfile ? 'Configure a connection profile to start chatting' : 'Send a message to the model…'
        }
      />
    </div>
  );
}
