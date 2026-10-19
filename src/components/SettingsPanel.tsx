/**
 * Settings drawer.
 *
 * Four sections: connection profiles, request parameters, interface
 * preferences and data handling. The drawer is a modal dialog: it traps the
 * focus, closes with Escape and returns the focus to the control that opened
 * it. Connections are explained in terms of the two addresses involved, which
 * is the single most common source of confusion.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_INFERENCE_PARAMS } from '../../shared/api/requests';
import type { ApiProfile } from '../../shared/domain';
import { APP_VERSION } from '../../shared/version';
import { createId } from '../lib/id';
import { useFocusTrap } from '../lib/useFocusTrap';
import { useApp } from '../state/AppProvider';
import { DataSettings } from './DataSettings';
import { InferenceSettings } from './InferenceSettings';
import { PreferencesSettings } from './PreferencesSettings';
import { ProfileForm } from './ProfileForm';
import { Badge, Icon } from './ui';

export type SettingsTab = 'connections' | 'inference' | 'preferences' | 'data';

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'connections', label: 'Connections' },
  { id: 'inference', label: 'Inference' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'data', label: 'Data & credentials' },
];

export interface SettingsPanelProps {
  open: boolean;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
}

function createDraftProfile(): ApiProfile {
  const now = new Date().toISOString();
  return {
    id: createId('profile'),
    name: 'New profile',
    baseUrl: 'http://127.0.0.1:8000/v1',
    modelId: '',
    systemPrompt: '',
    timeoutMs: 120_000,
    credentialStorage: 'session',
    defaultParams: { ...DEFAULT_INFERENCE_PARAMS },
    createdAt: now,
    updatedAt: now,
  };
}

function headerLabel(tab: SettingsTab): string {
  return SETTINGS_TABS.find((entry) => entry.id === tab)?.label ?? 'Settings';
}

export function SettingsPanel({ open, tab, onTabChange, onClose }: SettingsPanelProps) {
  const app = useApp();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The draft is created once so that its id stays stable while it is edited.
  const [draftProfile, setDraftProfile] = useState<ApiProfile | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<Element | null>(null);
  const tabListRef = useRef<HTMLDivElement>(null);

  const closePanel = useCallback(() => {
    setCreating(false);
    setEditingId(null);
    setDraftProfile(null);
    onClose();
  }, [onClose]);

  useFocusTrap(drawerRef, open);

  useEffect(() => {
    if (!open) return undefined;
    previousFocus.current = document.activeElement;
    drawerRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      const target = previousFocus.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open, closePanel]);

  if (!open) return null;

  const profiles = app.state.profiles;
  const editingProfile = profiles.find((profile) => profile.id === editingId);

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = SETTINGS_TABS.findIndex((entry) => entry.id === tab);
    if (current === -1) return;
    let next: number;
    if (event.key === 'ArrowRight') next = (current + 1) % SETTINGS_TABS.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SETTINGS_TABS.length - 1;
    else return;
    event.preventDefault();
    const target = SETTINGS_TABS[next]!;
    onTabChange(target.id);
    tabListRef.current
      ?.querySelector<HTMLButtonElement>(`#settings-tab-${target.id}`)
      ?.focus();
  };

  const startCreating = () => {
    setDraftProfile(createDraftProfile());
    setCreating(true);
    setEditingId(null);
  };

  const finishEditing = () => {
    setCreating(false);
    setEditingId(null);
    setDraftProfile(null);
  };

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePanel();
      }}
    >
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        ref={drawerRef}
      >
        <div className="drawer__header">
          <div className="drawer__heading">
            <h2 id="settings-title">Settings</h2>
            <span className="drawer__version">Kaggle-Kit v{APP_VERSION}</span>
          </div>
          <button
            type="button"
            className="button button--ghost button--icon"
            aria-label="Close settings"
            onClick={closePanel}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div
          className="tabs"
          role="tablist"
          aria-label="Settings sections"
          ref={tabListRef}
          onKeyDown={onTabKeyDown}
        >
          {SETTINGS_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`settings-tab-${entry.id}`}
              className="tab"
              aria-selected={tab === entry.id}
              aria-controls={tab === entry.id ? `settings-panel-${tab}` : undefined}
              tabIndex={tab === entry.id ? 0 : -1}
              onClick={() => onTabChange(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div
          className="drawer__body"
          role="tabpanel"
          id={`settings-panel-${tab}`}
          aria-labelledby={`settings-tab-${tab}`}
          tabIndex={0}
        >
          <h3 className="drawer__section-title">{headerLabel(tab)}</h3>

          {tab === 'connections' ? (
            <div className="settings-stack">
              <section className="card card--quiet">
                <h4 className="card__title">Two addresses, one purpose</h4>
                <dl className="address-grid">
                  <dt>This page</dt>
                  <dd>
                    <code>{window.location.origin}</code>
                    <span className="field__hint">
                      Served by the local proxy. This is <strong>not</strong> the address of the
                      model.
                    </span>
                  </dd>
                  <dt>Model API</dt>
                  <dd>
                    <span>
                      The base URL of a profile — for example the <code>trycloudflare.com</code>{' '}
                      address printed by the Kaggle notebook.
                    </span>
                    <span className="field__hint">
                      The proxy calls it; the browser never does. A missing <code>/v1</code> is added
                      automatically.
                    </span>
                  </dd>
                </dl>
              </section>

              <div className="row row--between">
                <div>
                  <h4 className="card__title">Connection profiles</h4>
                  <p className="text-subtle" style={{ margin: 0 }}>
                    {profiles.length === 0
                      ? 'No profile yet.'
                      : `${profiles.length} profile${profiles.length === 1 ? '' : 's'}; one is active.`}
                  </p>
                </div>
                {creating ? null : (
                  <button type="button" className="button button--primary button--small" onClick={startCreating}>
                    <Icon name="plus" size={13} />
                    Add profile
                  </button>
                )}
              </div>

              {creating && draftProfile ? (
                <ProfileForm
                  key={draftProfile.id}
                  profile={draftProfile}
                  isNew
                  onSaved={finishEditing}
                  onCancel={finishEditing}
                  onDeleted={finishEditing}
                />
              ) : null}

              {!creating && profiles.length === 0 ? (
                <div className="notice notice--info">
                  <strong>Start with a connection</strong>
                  Paste the base URL and API key that the notebook printed. Without them this page
                  cannot reach a model.
                </div>
              ) : null}

              {!creating
                ? profiles.map((profile) => {
                    const isActive = profile.id === app.state.preferences.activeProfileId;
                    const test = app.state.connectionTests[profile.id];

                    if (profile.id === editingId && editingProfile) {
                      return (
                        <ProfileForm
                          key={editingProfile.id}
                          profile={editingProfile}
                          isNew={false}
                          onSaved={finishEditing}
                          onCancel={finishEditing}
                          onDeleted={finishEditing}
                        />
                      );
                    }

                    return (
                      <div
                        key={profile.id}
                        className="profile-card"
                        aria-current={isActive ? 'true' : undefined}
                        role="group"
                        aria-label={`Profile ${profile.name}`}
                      >
                        <div className="profile-card__row">
                          <div className="profile-card__identity">
                            <div className="profile-card__name">
                              {profile.name}
                              {isActive ? (
                                <span className="profile-card__active" title="Active profile">
                                  <Icon name="check" size={12} /> active
                                </span>
                              ) : null}
                            </div>
                            <div className="profile-card__url" title={profile.baseUrl}>
                              {profile.baseUrl}
                            </div>
                          </div>
                        </div>

                        <div className="row profile-card__badges">
                          <Badge tone={profile.modelId ? 'neutral' : 'warning'}>
                            {profile.modelId || 'first model of the server'}
                          </Badge>
                          <Badge tone="info">
                            {profile.credentialStorage === 'session'
                              ? 'key in memory'
                              : profile.credentialStorage === 'server'
                                ? 'key on the proxy'
                                : 'key in the browser'}
                          </Badge>
                          <Badge tone={test === undefined ? 'neutral' : test.ok ? 'ok' : 'danger'}>
                            {test === undefined ? 'not tested' : test.ok ? 'connected' : 'test failed'}
                          </Badge>
                          {profile.defaultParams.stream ? <Badge tone="neutral">streaming on</Badge> : null}
                          <span className="text-subtle">timeout {Math.round(profile.timeoutMs / 1000)} s</span>
                        </div>

                        <div className="row profile-card__actions">
                          <button
                            type="button"
                            className="button button--small"
                            onClick={() => app.selectProfile(profile.id)}
                            disabled={isActive}
                          >
                            {isActive ? 'In use' : 'Use this profile'}
                          </button>
                          <button
                            type="button"
                            className="button button--small"
                            onClick={() => {
                              setCreating(false);
                              setEditingId(profile.id);
                            }}
                          >
                            <Icon name="edit" size={13} />
                            Edit
                          </button>
                        </div>
                      </div>
                    );
                  })
                : null}

              <section className="card card--quiet">
                <h4 className="card__title">When do I need to restart the proxy?</h4>
                <ul className="note-list">
                  <li>
                    After changing <code>KAGGLE_KIT_ALLOWED_HOSTS</code> or another{' '}
                    <code>KAGGLE_KIT_*</code> variable, because the proxy reads them at start-up.
                  </li>
                  <li>After changing the port of the proxy; the notebook is not affected.</li>
                  <li>
                    A new connection profile or a new API key does <strong>not</strong> need a
                    restart: both are read per request.
                  </li>
                </ul>
              </section>
            </div>
          ) : null}

          {tab === 'inference' ? <InferenceSettings profile={app.activeProfile} /> : null}
          {tab === 'preferences' ? <PreferencesSettings /> : null}
          {tab === 'data' ? <DataSettings /> : null}
        </div>
      </div>
    </div>
  );
}
