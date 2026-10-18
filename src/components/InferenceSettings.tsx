/**
 * Inference settings.
 *
 * These are the *request time* parameters of the active profile. Startup
 * options of the model server (context size, multi-GPU split, speculative
 * decoding) are deliberately kept separate: the browser cannot change them.
 */

import { useState } from 'react';

import { REASONING_EFFORT_STARTUP_NOTE } from '../../shared/api/requests';
import type { ReasoningEffort } from '../../shared/api/requests';
import type { ApiProfile } from '../../shared/domain';
import { gateway } from '../lib/gateway';
import { useApp } from '../state/AppProvider';
import { Badge, Icon } from './ui';

export interface InferenceSettingsProps {
  profile: ApiProfile | undefined;
}

export function InferenceSettings({ profile }: InferenceSettingsProps) {
  const app = useApp();
  const capabilities = profile ? app.state.capabilities[profile.id] : undefined;
  const [draft, setDraft] = useState(profile?.defaultParams);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [draftProfileId, setDraftProfileId] = useState(profile?.id);

  // Start a new draft when another profile is selected.
  if (profile?.id !== draftProfileId) {
    setDraftProfileId(profile?.id);
    setDraft(profile?.defaultParams);
  }

  if (!profile || !draft) {
    return (
      <div className="notice notice--info">
        <strong>No profile selected</strong>
        Select a connection profile to configure its inference parameters.
      </div>
    );
  }

  const update = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const save = () => {
    app.saveProfile({ ...profile, defaultParams: draft });
  };

  const reset = () => {
    setDraft({
      maxTokens: 1024,
      temperature: 0.7,
      topP: 0.95,
      frequencyPenalty: undefined,
      presencePenalty: undefined,
      reasoningEffort: null,
      stream: false,
    });
  };

  const verifyStreaming = async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      const credential =
        profile.credentialStorage === 'server'
          ? { secretRef: profile.secretRef }
          : {
              apiKey:
                profile.credentialStorage === 'browser'
                  ? app.state.browserKeys[profile.id]
                  : app.state.sessionKeys[profile.id],
            };

      const result = await gateway.probeStreaming({
        baseUrl: profile.baseUrl,
        model: profile.modelId || undefined,
        timeoutMs: profile.timeoutMs,
        ...credential,
      });

      setProbeResult(result.detail);
      app.dispatch({
        type: 'capabilities/set',
        profileId: profile.id,
        capabilities: {
          streamingVerified: result.supported,
          reasoningEffortSupported: capabilities?.reasoningEffortSupported ?? false,
          notes: capabilities?.notes ?? [],
        },
      });
    } catch (error) {
      setProbeResult(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(false);
    }
  };

  const streamingEnabled = Boolean(capabilities?.streamingVerified);

  return (
    <div>
      <div className="card">
        <h3 className="card__title">Request parameters</h3>
        <p className="card__description">
          These values are sent with every request of the profile{' '}
          <strong>{profile.name}</strong>.
        </p>

        <div className="field">
          <label className="field__label" htmlFor="max-tokens">
            Maximum output tokens
          </label>
          <input
            id="max-tokens"
            type="number"
            min={1}
            max={32768}
            value={draft.maxTokens}
            onChange={(event) => update('maxTokens', Number(event.target.value))}
          />
          <span className="field__hint">
            Upper bound for the generated answer. Larger values need more time and VRAM.
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="temperature">
            Temperature
          </label>
          <div className="range-row">
            <input
              id="temperature"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={draft.temperature}
              onChange={(event) => update('temperature', Number(event.target.value))}
            />
            <input
              type="number"
              aria-label="Temperature value"
              min={0}
              max={2}
              step={0.05}
              value={draft.temperature}
              onChange={(event) => update('temperature', Number(event.target.value))}
            />
          </div>
          <span className="field__hint">0 is deterministic, higher values are more creative.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="top-p">
            Top-p
          </label>
          <div className="range-row">
            <input
              id="top-p"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={draft.topP}
              onChange={(event) => update('topP', Number(event.target.value))}
            />
            <input
              type="number"
              aria-label="Top-p value"
              min={0}
              max={1}
              step={0.01}
              value={draft.topP}
              onChange={(event) => update('topP', Number(event.target.value))}
            />
          </div>
          <span className="field__hint">Nucleus sampling cutoff.</span>
        </div>

        <div className="field">
          <label className="checkbox" htmlFor="frequency-penalty-enabled">
            <input
              id="frequency-penalty-enabled"
              type="checkbox"
              checked={draft.frequencyPenalty !== undefined}
              onChange={(event) =>
                update('frequencyPenalty', event.target.checked ? 0 : undefined)
              }
            />
            <span>
              Send a frequency penalty
              <span className="field__hint" style={{ display: 'block' }}>
                When disabled the parameter is left out of the request entirely.
              </span>
            </span>
          </label>
          {draft.frequencyPenalty !== undefined ? (
            <input
              type="number"
              aria-label="Frequency penalty value"
              min={-2}
              max={2}
              step={0.1}
              value={draft.frequencyPenalty}
              onChange={(event) => update('frequencyPenalty', Number(event.target.value))}
            />
          ) : null}
        </div>

        <div className="field">
          <label className="checkbox" htmlFor="presence-penalty-enabled">
            <input
              id="presence-penalty-enabled"
              type="checkbox"
              checked={draft.presencePenalty !== undefined}
              onChange={(event) => update('presencePenalty', event.target.checked ? 0 : undefined)}
            />
            <span>
              Send a presence penalty
              <span className="field__hint" style={{ display: 'block' }}>
                When disabled the parameter is left out of the request entirely.
              </span>
            </span>
          </label>
          {draft.presencePenalty !== undefined ? (
            <input
              type="number"
              aria-label="Presence penalty value"
              min={-2}
              max={2}
              step={0.1}
              value={draft.presencePenalty}
              onChange={(event) => update('presencePenalty', Number(event.target.value))}
            />
          ) : null}
        </div>
      </div>

      <div className="card">
        <h3 className="card__title">Reasoning effort</h3>
        <p className="card__description">{REASONING_EFFORT_STARTUP_NOTE}</p>

        <div className="field">
          <label className="field__label" htmlFor="reasoning-effort">
            Effort sent with the request
          </label>
          <select
            id="reasoning-effort"
            value={draft.reasoningEffort ?? ''}
            onChange={(event) =>
              update(
                'reasoningEffort',
                event.target.value === '' ? null : (event.target.value as ReasoningEffort),
              )
            }
            disabled={!capabilities?.reasoningEffortSupported}
          >
            <option value="">Do not send (server startup value is used)</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <span className="field__hint">
            {capabilities?.reasoningEffortSupported
              ? 'The connected server advertises a per request reasoning_effort option.'
              : 'The connected server did not advertise this option, so the value is not sent.'}
          </span>
        </div>
      </div>

      <div className="card">
        <h3 className="card__title">Streaming</h3>
        <p className="card__description">
          Streaming needs a transport that supports Server-Sent Events. Cloudflare Quick Tunnels do
          not, which is why the option stays off until a real streaming request succeeds.
        </p>

        <label className="checkbox" htmlFor="streaming-enabled">
          <input
            id="streaming-enabled"
            type="checkbox"
            checked={draft.stream && streamingEnabled}
            disabled={!streamingEnabled}
            onChange={(event) => update('stream', event.target.checked)}
          />
          <span>
            Stream the answer
            <span className="field__hint" style={{ display: 'block' }}>
              {streamingEnabled
                ? 'The endpoint delivered a text/event-stream response during verification.'
                : 'Disabled until streaming is verified for this endpoint.'}
            </span>
          </span>
        </label>

        <div className="row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="button button--small"
            onClick={() => void verifyStreaming()}
            disabled={probing}
          >
            <Icon name="refresh" size={13} />
            {probing ? 'Verifying…' : 'Verify streaming support'}
          </button>
          {streamingEnabled ? <Badge tone="ok">streaming verified</Badge> : null}
        </div>

        {probeResult ? (
          <div
            className={`notice ${streamingEnabled ? 'notice--success' : 'notice--warning'}`}
            style={{ marginTop: 12 }}
          >
            {probeResult}
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3 className="card__title">Server startup options</h3>
        <p className="card__description">
          These are set when the model server starts and cannot be changed from the browser. They
          come from the Kaggle notebook cell.
        </p>
        <div className="notice">
          Context size, GPU layer split and speculative decoding (MTP) are start-up flags of
          <code> llama-server</code>. Restart the server with different values to change them.
        </div>
      </div>

      <div className="row row--between">
        <button type="button" className="button" onClick={reset}>
          Reset to defaults
        </button>
        <button type="button" className="button button--primary" onClick={save}>
          Save parameters
        </button>
      </div>
    </div>
  );
}
