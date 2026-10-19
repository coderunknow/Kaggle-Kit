/**
 * Settings drawer.
 *
 * Three tabs: connection profiles, inference parameters and data handling.
 */

import { useEffect, useRef, useState } from 'react';

import { DEFAULT_INFERENCE_PARAMS } from '../../shared/api/requests';
import type { ApiProfile } from '../../shared/domain';
import { createId } from '../lib/id';
import { useApp } from '../state/AppProvider';
import { DataSettings } from './DataSettings';
import { InferenceSettings } from './InferenceSettings';
import { ProfileForm } from './ProfileForm';
import { Badge, Icon } from './ui';

export type SettingsTab = 'connections' | 'inference' | 'data';

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

export function SettingsPanel({ open, tab, onTabChange, onClose }: SettingsPanelProps) {
  const app = useApp();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The draft is created once so that its id stays stable while it is edited.
  const [draftProfile, setDraftProfile] = useState<ApiProfile | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement;
    drawerRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const target = previousFocus.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open, onClose]);

  // Reset the editor when the drawer is closed. Adjusting the state while
  // rendering is the pattern React recommends for a changed prop.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setCreating(false);
      setEditingId(null);
      setDraftProfile(null);
    }
  }

  if (!open) return null;

  const profiles = app.state.profiles;
  const editingProfile = profiles.find((profile) => profile.id === editingId);

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        ref={drawerRef}
      >
        <div className="drawer__header">
          <h2>Settings</h2>
          <button type="button" className="button button--ghost button--icon" aria-label="Close settings" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="tabs" role="tablist" aria-label="Settings sections">
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === 'connections'}
            onClick={() => onTabChange('connections')}
          >
            Connections
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === 'inference'}
            onClick={() => onTabChange('inference')}
          >
            Inference
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === 'data'}
            onClick={() => onTabChange('data')}
          >
            Data &amp; credentials
          </button>
        </div>

        <div className="drawer__body">
          {tab === 'connections' ? (
            <div>
              <div className="row row--between" style={{ marginBottom: 12 }}>
                <p className="text-subtle" style={{ margin: 0 }}>
                  {profiles.length} profile{profiles.length === 1 ? '' : 's'}
                </p>
                <button
                  type="button"
                  className="button button--primary button--small"
                  onClick={() => {
                    setDraftProfile(createDraftProfile());
                    setCreating(true);
                    setEditingId(null);
                  }}
                >
                  <Icon name="plus" size={13} />
                  Add profile
                </button>
              </div>

              {creating && draftProfile ? (
                <ProfileForm
                  key={draftProfile.id}
                  profile={draftProfile}
                  isNew
                  onSaved={() => {
                    setCreating(false);
                    setDraftProfile(null);
                  }}
                  onCancel={() => {
                    setCreating(false);
                    setDraftProfile(null);
                  }}
                  onDeleted={() => {
                    setCreating(false);
                    setDraftProfile(null);
                  }}
                />
              ) : null}

              {profiles.length === 0 && !creating ? (
                <div className="notice notice--info">
                  <strong>No connection profile yet</strong>
                  Add one with the base URL and the API key of your model server.
                </div>
              ) : null}

              {profiles.map((profile) => {
                const isActive = profile.id === app.state.preferences.activeProfileId;
                const isEditing = profile.id === editingId;

                return (
                  <div key={profile.id}>
                    {isEditing && editingProfile ? (
                      <ProfileForm
                        key={editingProfile.id}
                        profile={editingProfile}
                        isNew={false}
                        onSaved={() => setEditingId(null)}
                        onCancel={() => setEditingId(null)}
                        onDeleted={() => setEditingId(null)}
                      />
                    ) : (
                      <div
                        className="profile-card"
                        aria-current={isActive}
                        role="group"
                        aria-label={`Profile ${profile.name}`}
                      >
                        <div className="profile-card__row">
                          <div style={{ minWidth: 0 }}>
                            <div className="profile-card__name">{profile.name}</div>
                            <div className="profile-card__url">{profile.baseUrl}</div>
                          </div>
                          {isActive ? <Badge tone="ok">active</Badge> : null}
                        </div>

                        <div className="row" style={{ marginTop: 10 }}>
                          <Badge tone={profile.modelId ? 'neutral' : 'warning'}>
                            {profile.modelId || 'no model set'}
                          </Badge>
                          <Badge tone="info">
                            {profile.credentialStorage === 'session'
                              ? 'key in memory'
                              : profile.credentialStorage === 'server'
                                ? 'key on proxy'
                                : 'key in browser'}
                          </Badge>
                          <span className="text-subtle">timeout {profile.timeoutMs} ms</span>
                        </div>

                        <div className="row" style={{ marginTop: 10 }}>
                          <button
                            type="button"
                            className="button button--small"
                            onClick={() => app.selectProfile(profile.id)}
                            disabled={isActive}
                          >
                            Use this profile
                          </button>
                          <button
                            type="button"
                            className="button button--small"
                            onClick={() => {
                              setCreating(false);
                              setEditingId(profile.id);
                            }}
                          >
                            Edit
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {tab === 'inference' ? <InferenceSettings profile={app.activeProfile} /> : null}

          {tab === 'data' ? <DataSettings /> : null}
        </div>
      </div>
    </div>
  );
}
