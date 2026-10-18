/**
 * Data and credential management.
 *
 * Makes it explicit what is stored where and gives the user a way to remove
 * every trace of a credential or a conversation.
 */

import { useEffect, useState } from 'react';

import { gateway } from '../lib/gateway';
import { useApp } from '../state/AppProvider';
import { Icon } from './ui';

export function DataSettings() {
  const app = useApp();
  const { profiles, conversations, sessionKeys, browserKeys } = app.state;
  const [serverRefs, setServerRefs] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const refreshServerRefs = async () => {
    try {
      const refs = await gateway.listSecrets();
      setServerRefs(refs);
    } catch {
      setServerRefs([]);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const references = await gateway.listSecrets().catch(() => [] as string[]);
      if (!cancelled) setServerRefs(references);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sessionCount = Object.keys(sessionKeys).length;
  const browserCount = Object.keys(browserKeys).length;

  return (
    <div>
      <div className="card">
        <h3 className="card__title">Stored in this browser</h3>
        <p className="card__description">
          Profiles, conversations and UI preferences are kept in local storage so they survive a
          reload. They never leave this machine.
        </p>
        <ul className="list-reset text-small stack stack--tight">
          <li>Connection profiles: {profiles.length}</li>
          <li>Conversations: {conversations.length}</li>
          <li>API keys in memory (session mode): {sessionCount}</li>
          <li>API keys in browser storage (opt-in): {browserCount}</li>
        </ul>
        {browserCount > 0 ? (
          <div className="notice notice--warning" style={{ marginTop: 12 }}>
            <strong>Plain text keys in this browser</strong>
            Browser storage is readable by any script that runs on this origin. Remove them below
            unless you explicitly want them to persist.
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3 className="card__title">Stored by the local proxy</h3>
        <p className="card__description">
          Profiles that use the &quot;local proxy secret store&quot; keep their key in a 0600 file next
          to the backend. The key is never sent to the browser.
        </p>
        {serverRefs.length === 0 ? (
          <p className="text-subtle">No keys are stored by the proxy.</p>
        ) : (
          <ul className="list-reset stack stack--tight">
            {serverRefs.map((ref) => (
              <li key={ref} className="row row--between">
                <code>{ref}</code>
                <button
                  type="button"
                  className="button button--small button--danger"
                  onClick={async () => {
                    await gateway.deleteSecret(ref);
                    await refreshServerRefs();
                    setStatus(`Removed the stored key ${ref}.`);
                  }}
                >
                  <Icon name="trash" size={13} />
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h3 className="card__title">Erase data</h3>
        <p className="card__description">
          Removing data is immediate and cannot be undone.
        </p>

        <div className="stack stack--tight">
          <button
            type="button"
            className="button button--block"
            onClick={() => {
              app.clearCredentials();
              setStatus('Cleared the API keys held in memory and in browser storage.');
            }}
          >
            Clear all API keys in this browser
          </button>

          <button
            type="button"
            className="button button--block"
            onClick={() => {
              for (const conversation of app.state.conversations) {
                app.deleteConversation(conversation.id);
              }
              setStatus('Deleted every conversation.');
            }}
          >
            Delete all conversations
          </button>

          <button
            type="button"
            className="button button--block button--danger"
            onClick={() => {
              app.resetEverything();
              setStatus('Erased all local data. Reload the page to start over.');
            }}
          >
            <Icon name="trash" size={14} />
            Erase all local data
          </button>
        </div>

        {status ? (
          <div className="notice notice--info" style={{ marginTop: 12 }}>
            {status}
          </div>
        ) : null}
      </div>

      <div className="notice">
        Conversations and credentials are never sent to analytics or to any third party service.
        The only network requests are the ones you configure, between this browser and the local
        proxy, and from the proxy to the endpoint you configured.
      </div>
    </div>
  );
}
