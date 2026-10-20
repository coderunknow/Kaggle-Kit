/**
 * Application shell.
 *
 * The sidebar owns the history, the top bar owns the context (conversation,
 * connection, export, theme), the chat owns the conversation. Settings are a
 * modal drawer. Keyboard shortcuts are global but never steal a keystroke
 * from the composer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { effectiveProfileTarget, resolveConnectionView } from '../shared/connection';
import type { ChatMessage } from '../shared/domain';
import { ChatView, type ConnectionState } from './components/ChatView';
import { SettingsPanel, type SettingsTab } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { Icon, StatusDot, type StatusTone } from './components/ui';
import { copyText } from './lib/clipboard';
import { downloadConversation } from './lib/export';
import { gateway } from './lib/gateway';
import { useMediaQuery } from './lib/useMediaQuery';
import { useApp } from './state/AppProvider';
import { useChat } from './state/useChat';

export function App() {
  const app = useApp();
  const { activeProfile, activeConversation, state, newConversation } = app;
  const { sendMessage, editMessage, retryMessage, resendMessage, approveToolCall, cancelToolJob, isPending } = useChat();
  const isWide = useMediaQuery('(min-width: 1024px)');
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connections');
  const [proxyOnline, setProxyOnline] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const noticeTimer = useRef<number | null>(null);
  const queuedMessage = useRef<string | null>(null);
  const queuedFor = useRef<string | null>(null);

  const sidebarOpen = isWide ? desktopSidebarOpen : mobileSidebarOpen;
  const conversationId = activeConversation?.id;

  const setSidebarOpen = (open: boolean) => {
    if (isWide) setDesktopSidebarOpen(open);
    else setMobileSidebarOpen(open);
  };

  const openSettings = useCallback((tab: SettingsTab = 'connections') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  // Stable so the drawer effect that moves and restores the focus does not
  // run again on every render of the application.
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3000);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  // Theme: an explicit choice is written to the root element; `system` removes
  // the attribute so the media query in the stylesheet takes over.
  useEffect(() => {
    const root = document.documentElement;
    if (state.preferences.theme === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = state.preferences.theme;
    }
  }, [state.preferences.theme]);

  // Health of the local proxy. A failure is shown as a banner, never hidden.
  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const healthy = await gateway.health();
      if (!cancelled) setProxyOnline(healthy);
    };

    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const handleNewConversation = useCallback(() => {
    queuedMessage.current = null;
    queuedFor.current = null;
    newConversation();
    if (!isWide) setMobileSidebarOpen(false);
  }, [newConversation, isWide]);

  /**
   * Sending from the landing view creates the conversation first. The id is
   * remembered and the send is started once the new conversation is in state.
   */
  const handleSend = useCallback(
    (content: string) => {
      if (conversationId) {
        void sendMessage(conversationId, content);
        return;
      }
      queuedMessage.current = content;
      queuedFor.current = newConversation();
    },
    [conversationId, newConversation, sendMessage],
  );

  useEffect(() => {
    if (!conversationId || queuedFor.current !== conversationId) return;
    // The first message of a conversation started from the landing view is
    // sent once the new conversation exists in the provider state.
    queuedFor.current = null;
    const queued = queuedMessage.current;
    queuedMessage.current = null;
    if (queued) void sendMessage(conversationId, queued);
  }, [conversationId, sendMessage]);

  const handleCancel = useCallback(() => {
    if (conversationId) void cancelToolJob(conversationId);
  }, [cancelToolJob, conversationId]);

  const handleToolApproval = useCallback((messageId: string, approvalId: string, approved: boolean) => {
    if (conversationId) void approveToolCall(conversationId, messageId, approvalId, approved);
  }, [approveToolCall, conversationId]);

  const handleCopy = useCallback((message: ChatMessage) => copyText(message.content), []);

  const handleEdit = useCallback(
    (messageId: string, content: string) => {
      if (conversationId) void editMessage(conversationId, messageId, content);
    },
    [editMessage, conversationId],
  );

  const handleRetry = useCallback(
    (messageId: string) => {
      if (conversationId) void retryMessage(conversationId, messageId);
    },
    [retryMessage, conversationId],
  );

  const handleResend = useCallback(
    (messageId: string) => {
      if (conversationId) void resendMessage(conversationId, messageId);
    },
    [resendMessage, conversationId],
  );

  const handleExport = useCallback(() => {
    if (!activeConversation) return;
    const saved = downloadConversation(activeConversation, activeProfile);
    showNotice(saved ? 'Conversation exported as Markdown.' : 'The browser blocked the download.');
  }, [activeConversation, activeProfile, showNotice]);

  // Global shortcuts. They are listed in the preferences tab.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      // Alt+Shift+N is not claimed by the major browsers, unlike
      // Ctrl+Shift+O, which opens the bookmark manager in Chromium.
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        newConversation();
        if (!isWide) setMobileSidebarOpen(false);
        return;
      }
      if (mod && event.key === '/') {
        event.preventDefault();
        composerRef.current?.focus();
        return;
      }
      if (event.key === 'Escape' && !isWide && !settingsOpen) {
        setMobileSidebarOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [newConversation, isWide, settingsOpen]);

  const pending = conversationId ? isPending(conversationId) : false;
  const connection = resolveConnectionView(state, activeProfile);
  const connectionState: ConnectionState = connection.state;

  const connectionTone: StatusTone =
    proxyOnline === false ? 'danger' : connection.tone;

  const connectionLabel = !activeProfile
    ? 'No connection profile'
    : `${activeProfile.name} · ${effectiveProfileTarget(activeProfile).baseUrl} · ${
        activeProfile.modelId || 'first model of the server'
      } · ${connection.label}`;

  const effectiveTheme =
    state.preferences.theme === 'system'
      ? prefersDark
        ? 'dark'
        : 'light'
      : state.preferences.theme;
  const messageCount = activeConversation?.messages.length ?? 0;

  return (
    <div className="app-shell" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      <a className="skip-link" href="#main">
        Skip to the conversation
      </a>

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNavigate={() => {
          if (!isWide) setMobileSidebarOpen(false);
        }}
        onOpenSettings={() => openSettings('connections')}
        onNewConversation={handleNewConversation}
      />

      <div className="app-main">
        <header className="topbar">
          <button
            type="button"
            className="button button--ghost button--icon topbar__menu"
            aria-label={sidebarOpen ? 'Hide the conversations sidebar' : 'Show the conversations sidebar'}
            aria-expanded={sidebarOpen}
            aria-controls="conversation-sidebar"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Icon name="sidebar" size={16} />
          </button>

          <div className="topbar__titles">
            <h1 className="topbar__title">{activeConversation?.title ?? 'Kaggle-Kit'}</h1>
            <span className="topbar__subtitle">
              {activeConversation
                ? `${messageCount} message${messageCount === 1 ? '' : 's'} in this conversation`
                : 'Your own model, behind a local proxy'}
            </span>
          </div>

          <div className="topbar__actions">
            {activeProfile ? (
              <button
                type="button"
                className="status-pill"
                aria-label={`Connection: ${connectionLabel}. Open the connection settings.`}
                title={connectionLabel}
                onClick={() => openSettings('connections')}
              >
                <StatusDot tone={connectionTone} />
                <span className="status-pill__name">{activeProfile.name}</span>
                <span className="status-pill__model">
                  {activeProfile.modelId || 'first model'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="button button--small"
                onClick={() => openSettings('connections')}
              >
                <Icon name="server" size={13} />
                Set up connection
              </button>
            )}

            <button
              type="button"
              className="button button--ghost button--icon"
              aria-label="Export the conversation as Markdown"
              title="Export as Markdown"
              onClick={handleExport}
              disabled={!activeConversation || messageCount === 0}
            >
              <Icon name="download" size={16} />
            </button>

            <button
              type="button"
              className="button button--ghost button--icon"
              aria-label={
                effectiveTheme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'
              }
              title="Change the color theme"
              onClick={() =>
                app.dispatch({
                  type: 'preferences/set',
                  preferences: { theme: effectiveTheme === 'dark' ? 'light' : 'dark' },
                })
              }
            >
              <Icon name={effectiveTheme === 'dark' ? 'sun' : 'moon'} size={16} />
            </button>

            <button
              type="button"
              className="button button--ghost button--icon"
              aria-label="Settings"
              title="Settings"
              onClick={() => openSettings('connections')}
            >
              <Icon name="settings" size={16} />
            </button>
          </div>
        </header>

        {proxyOnline === false ? (
          <div className="banner banner--danger" role="status">
            <Icon name="alert" size={15} />
            <span>
              The local proxy is unreachable. Start it with <code>npm start</code>, then reload this
              page.
            </span>
          </div>
        ) : null}

        {notice ? (
          <div className="banner banner--info" role="status">
            <Icon name="info" size={14} />
            <span>{notice}</span>
          </div>
        ) : null}

        <main className="app-main__content" id="main">
          <ChatView
            key={conversationId ?? 'no-conversation'}
            conversation={activeConversation}
            profile={activeProfile}
            pending={pending}
            connectionState={connectionState}
            onSend={handleSend}
            onCancel={handleCancel}
            onToolApproval={handleToolApproval}
            onCopy={handleCopy}
            onEdit={handleEdit}
            onRetry={handleRetry}
            onResend={handleResend}
            onRegenerate={handleRetry}
            onOpenSettings={() => openSettings('connections')}
            composerRef={composerRef}
          />
        </main>
      </div>

      <SettingsPanel
        open={settingsOpen}
        tab={settingsTab}
        onTabChange={setSettingsTab}
        onClose={closeSettings}
      />
    </div>
  );
}
