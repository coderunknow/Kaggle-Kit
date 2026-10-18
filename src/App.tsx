/**
 * Application shell.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ChatMessage } from '../shared/domain';
import { ChatView } from './components/ChatView';
import { SettingsPanel, type SettingsTab } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { Badge, Icon } from './components/ui';
import { gateway } from './lib/gateway';
import { useApp } from './state/AppProvider';
import { useChat } from './state/useChat';

export function App() {
  const app = useApp();
  const chat = useChat();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connections');
  const [proxyOnline, setProxyOnline] = useState<boolean | null>(null);

  const { activeProfile, activeConversation, state } = app;

  // Theme handling.
  useEffect(() => {
    const root = document.documentElement;
    if (state.preferences.theme === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = state.preferences.theme;
    }
  }, [state.preferences.theme]);

  // Local proxy health.
  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const healthy = await gateway.health();
      if (!cancelled) setProxyOnline(healthy);
    };

    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const copyMessage = useCallback(async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
    } catch {
      /* clipboard not available */
    }
  }, []);

  const pending = activeConversation ? chat.isPending(activeConversation.id) : false;

  const status = (() => {
    if (proxyOnline === false) {
      return <Badge tone="danger">proxy offline</Badge>;
    }
    if (!activeProfile) {
      return <Badge tone="warning">no profile</Badge>;
    }

    const test = state.connectionTests[activeProfile.id];
    if (!test) {
      return <Badge tone="info">not tested</Badge>;
    }
    return test.ok ? <Badge tone="ok">connected</Badge> : <Badge tone="danger">connection failed</Badge>;
  })();

  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          type="button"
          className="button button--ghost button--icon"
          aria-label="Toggle the sidebar"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <Icon name="menu" size={16} />
        </button>

        <div className="app-brand">
          <span className="app-brand__mark" aria-hidden="true">
            KK
          </span>
          <span className="app-brand__name">Kaggle-Kit</span>
        </div>

        {activeProfile ? (
          <Badge tone="neutral" title={activeProfile.baseUrl}>
            {activeProfile.name}
            {activeProfile.modelId ? ` · ${activeProfile.modelId}` : ''}
          </Badge>
        ) : null}

        {status}

        <div className="app-header__spacer" />

        <div className="app-header__actions">
          <button
            type="button"
            className="button button--ghost button--icon"
            aria-label={
              state.preferences.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'
            }
            onClick={() =>
              app.dispatch({
                type: 'preferences/set',
                preferences: { theme: state.preferences.theme === 'dark' ? 'light' : 'dark' },
              })
            }
          >
            <Icon name={state.preferences.theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>

          <button
            type="button"
            className="button"
            aria-label="Open settings"
            onClick={() => {
              setSettingsTab('connections');
              setSettingsOpen(true);
            }}
          >
            <Icon name="settings" size={15} />
            Settings
          </button>
        </div>
      </header>

      <div className="app-body">
        <Sidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onOpenSettings={() => {
            setSettingsTab('connections');
            setSettingsOpen(true);
          }}
        />

        <main className="app-main">
          <ChatView
            conversation={activeConversation}
            profile={activeProfile}
            pending={pending}
            onSend={(content) => {
              if (!activeConversation) return;
              void chat.sendMessage(activeConversation.id, content);
            }}
            onCancel={() => {
              if (activeConversation) app.cancelRequest(activeConversation.id);
            }}
            onCopy={copyMessage}
            onEdit={(messageId, content) => {
              if (!activeConversation) return;
              void chat.editMessage(activeConversation.id, messageId, content);
            }}
            onRetry={(messageId) => {
              if (!activeConversation) return;
              void chat.retryMessage(activeConversation.id, messageId);
            }}
            onResend={(messageId) => {
              if (!activeConversation) return;
              void chat.resendMessage(activeConversation.id, messageId);
            }}
            onRegenerate={(messageId) => {
              if (!activeConversation) return;
              void chat.retryMessage(activeConversation.id, messageId);
            }}
            onNewConversation={() => {
              app.newConversation();
            }}
            onOpenSettings={() => {
              setSettingsTab('connections');
              setSettingsOpen(true);
            }}
          />
        </main>
      </div>

      <SettingsPanel
        open={settingsOpen}
        tab={settingsTab}
        onTabChange={setSettingsTab}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
