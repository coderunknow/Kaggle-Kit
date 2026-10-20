/**
 * Interface preferences.
 *
 * The theme and the send shortcut are applied immediately: there is no save
 * button, because both are visible in the interface right away.
 */

import { APP_VERSION } from '../../shared/version';
import { useApp } from '../state/AppProvider';
import { Icon } from './ui';

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Alt + Shift + N', action: 'New conversation' },
  { keys: 'Ctrl / Cmd + /', action: 'Focus the message field' },
  { keys: 'Esc', action: 'Close the sidebar or the settings' },
  { keys: 'Ctrl / Cmd + Enter', action: 'Send when the Enter key is set to a new line' },
  { keys: 'Shift + Enter', action: 'Insert a new line' },
];

export function PreferencesSettings() {
  const app = useApp();
  const { theme, sendOnEnter } = app.state.preferences;

  return (
    <div className="settings-stack">
      <section className="card">
        <h3 className="card__title">Appearance</h3>
        <p className="card__description">
          The system setting follows the theme of your operating system. An explicit choice wins
          over it and is stored in this browser.
        </p>
        <fieldset className="choice-group">
          <legend className="visually-hidden">Color theme</legend>
          {(
            [
              ['system', 'System'],
              ['light', 'Light'],
              ['dark', 'Dark'],
            ] as const
          ).map(([value, label]) => (
            <label className="choice" key={value}>
              <input
                type="radio"
                name="theme"
                value={value}
                checked={theme === value}
                onChange={() => app.dispatch({ type: 'preferences/set', preferences: { theme: value } })}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card">
        <h3 className="card__title">Sending</h3>
        <p className="card__description">
          Ctrl+Enter always sends, even when Enter inserts a line break.
        </p>
        <fieldset className="choice-group">
          <legend className="visually-hidden">Send shortcut</legend>
          <label className="choice">
            <input
              type="radio"
              name="send-shortcut"
              checked={sendOnEnter}
              onChange={() =>
                app.dispatch({ type: 'preferences/set', preferences: { sendOnEnter: true } })
              }
            />
            <span>
              Enter sends
              <span className="field__hint">Shift+Enter inserts a new line.</span>
            </span>
          </label>
          <label className="choice">
            <input
              type="radio"
              name="send-shortcut"
              checked={!sendOnEnter}
              onChange={() =>
                app.dispatch({ type: 'preferences/set', preferences: { sendOnEnter: false } })
              }
            />
            <span>
              Ctrl+Enter sends
              <span className="field__hint">Enter inserts a new line, which is safer for long prompts.</span>
            </span>
          </label>
        </fieldset>
      </section>

      <section className="card">
        <h3 className="card__title">Keyboard</h3>
        <dl className="shortcut-list">
          {SHORTCUTS.map((shortcut) => (
            <div className="shortcut" key={shortcut.keys}>
              <dt>
                <kbd>{shortcut.keys}</kbd>
              </dt>
              <dd>{shortcut.action}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card">
        <h3 className="card__title">About</h3>
        <p className="card__description">
          Kaggle-Kit <strong>v{APP_VERSION}</strong> — a browser client, a local proxy and a Kaggle
          deployment for an OpenAI-compatible llama.cpp server.
        </p>
        <div className="about-grid">
          <span>Interface</span>
          <span>React, plain CSS design tokens</span>
          <span>Proxy</span>
          <span>node:http, no runtime dependencies</span>
          <span>Credentials</span>
          <span>Memory, proxy file or explicit browser storage</span>
        </div>
        <p className="text-subtle">
          <Icon name="info" size={12} /> Nothing is sent to an analytics service. Requests only go
          to the local proxy and from there to the endpoint you configured.
        </p>
      </section>
    </div>
  );
}
