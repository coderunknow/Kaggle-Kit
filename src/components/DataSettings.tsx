/**
 * Data and credential management.
 *
 * Makes it explicit what is stored where and gives the user a way to remove
 * every trace of a credential or a conversation. Errors of the proxy are
 * reported instead of being shown as an empty list.
 */

import { useEffect, useState } from 'react';

import { APP_VERSION } from '../../shared/version';
import { gateway } from '../lib/gateway';
import { loadDrafts } from '../lib/storage';
import { useApp } from '../state/AppProvider';
import { Icon } from './ui';

type Confirmation = 'none' | 'conversations' | 'everything';

export function DataSettings() {
  const app = useApp();
  const { profiles, conversations, sessionKeys, browserKeys } = app.state;
  const [serverRefs, setServerRefs] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>('none');

  const refreshServerRefs = async () => {
    try {
      const refs = await gateway.listSecrets();
      setServerRefs(refs);
      setServerError(null);
    } catch (error) {
      setServerRefs([]);
      setServerError(
        error instanceof Error
          ? error.message
          : 'The secret store of the local proxy could not be read.',
      );
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const references = await gateway.listSecrets();
        if (!cancelled) {
          setServerRefs(references);
          setServerError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setServerError(
            error instanceof Error
              ? error.message
              : 'The secret store of the local proxy could not be read.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sessionCount = Object.keys(sessionKeys).length;
  const browserCount = Object.keys(browserKeys).length;
  const draftCount = Object.keys(loadDrafts()).length;

  return (
    <div className="settings-stack">
      <section className="card">
        <h3 className="card__title">Stored in this browser</h3>
        <p className="card__description">
          Profiles, conversations, drafts and UI preferences are kept in local storage so they
          survive a reload. They never leave this machine.
        </p>
        <ul className="list-reset data-list">
          <li>
            <span>Connection profiles</span>
            <strong>{profiles.length}</strong>
          </li>
          <li>
            <span>Conversations</span>
            <strong>{conversations.length}</strong>
          </li>
          <li>
            <span>Composer drafts</span>
            <strong>{draftCount}</strong>
          </li>
          <li>
            <span>API keys in memory (session mode)</span>
            <strong>{sessionCount}</strong>
          </li>
          <li>
            <span>API keys in browser storage (opt-in)</span>
            <strong>{browserCount}</strong>
          </li>
        </ul>
        {browserCount > 0 ? (
          <div className="notice notice--warning" style={{ marginTop: 12 }}>
            <strong>Plain text keys in this browser</strong>
            Browser storage is readable by any script that runs on this origin. Remove them below
            unless you explicitly want them to persist.
          </div>
        ) : null}
      </section>

      <section className="card">
        <h3 className="card__title">Stored by the local proxy</h3>
        <p className="card__description">
          Profiles that use the “local proxy secret store” keep their key in a 0600 file next to the
          backend. The key is never sent to the browser.
        </p>
        {serverError ? (
          <div className="notice notice--warning">
            <strong>The proxy secret store is not readable</strong>
            {serverError}
          </div>
        ) : serverRefs.length === 0 ? (
          <p className="text-subtle">No keys are stored by the proxy.</p>
        ) : (
          <ul className="list-reset data-list">
            {serverRefs.map((reference) => (
              <li key={reference}>
                <code>{reference}</code>
                <button
                  type="button"
                  className="button button--small button--danger"
                  onClick={async () => {
                    try {
                      await gateway.deleteSecret(reference);
                      await refreshServerRefs();
                      setStatus(`Removed the stored key ${reference}.`);
                    } catch (error) {
                      setStatus(
                        error instanceof Error
                          ? `The key could not be removed: ${error.message}`
                          : 'The key could not be removed.',
                      );
                    }
                  }}
                >
                  <Icon name="trash" size={13} />
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3 className="card__title">Erase data</h3>
        <p className="card__description">Removing data is immediate and cannot be undone.</p>

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

          {confirmation === 'conversations' ? (
            <div className="row confirm-row">
              <span className="text-small">Delete {conversations.length} conversations?</span>
              <button
                type="button"
                className="button button--danger button--small"
                onClick={() => {
                  for (const conversation of app.state.conversations) {
                    app.deleteConversation(conversation.id);
                  }
                  setConfirmation('none');
                  setStatus('Deleted every conversation.');
                }}
              >
                Yes, delete all
              </button>
              <button type="button" className="button button--small" onClick={() => setConfirmation('none')}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button button--block"
              onClick={() => setConfirmation('conversations')}
              disabled={conversations.length === 0}
            >
              Delete all conversations
            </button>
          )}

          {confirmation === 'everything' ? (
            <div className="row confirm-row">
              <span className="text-small">Erase profiles, conversations, drafts and keys?</span>
              <button
                type="button"
                className="button button--danger button--small"
                onClick={() => {
                  app.resetEverything();
                  setConfirmation('none');
                  setStatus('Erased all local data. Reload the page to start over.');
                }}
              >
                Yes, erase everything
              </button>
              <button type="button" className="button button--small" onClick={() => setConfirmation('none')}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button button--block button--danger"
              onClick={() => setConfirmation('everything')}
            >
              <Icon name="trash" size={14} />
              Erase all local data
            </button>
          )}
        </div>

        {status ? (
          <div className="notice notice--info" style={{ marginTop: 12 }} role="status">
            {status}
          </div>
        ) : null}
      </section>

      <section className="card card--quiet">
        <h3 className="card__title">Privacy</h3>
        <p className="card__description">
          Conversations and credentials are never sent to analytics or to a third party service.
          The only network requests are the ones you configure: between this browser and the local
          proxy, and from the proxy to the endpoint of the profile.
        </p>
        <p className="text-subtle">
          Kaggle-Kit v{APP_VERSION}. Export a conversation with the download button in the top bar
          to keep a copy outside the browser.
        </p>
      </section>
    </div>
  );
}
