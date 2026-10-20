/**
 * Inference settings.
 *
 * These are the *request time* parameters of the active profile. Startup
 * options of the model server (context size, GPU split, speculative
 * decoding) are deliberately kept separate: the browser cannot change them.
 *
 * Parameters that the connected server does not support are omitted from the
 * request. The summary at the bottom names them instead of pretending that
 * they were sent.
 */

import { useState } from 'react';

import {
  REASONING_EFFORT_STARTUP_NOTE,
  buildChatCompletionBody,
  type InferenceParams,
  type ReasoningEffort,
} from '../../shared/api/requests';
import { LIMITS, REASONING_EFFORTS } from '../../shared/api/validation';
import {
  effectiveProfileTarget,
  resolveProfileCredential,
} from '../../shared/connection';
import type { ApiProfile } from '../../shared/domain';
import { gateway } from '../lib/gateway';
import { useApp } from '../state/AppProvider';
import { Badge, Icon } from './ui';

export interface InferenceSettingsProps {
  profile: ApiProfile | undefined;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sameParams(left: InferenceParams, right: InferenceParams): boolean {
  return (
    left.maxTokens === right.maxTokens &&
    left.temperature === right.temperature &&
    left.topP === right.topP &&
    left.frequencyPenalty === right.frequencyPenalty &&
    left.presencePenalty === right.presencePenalty &&
    left.reasoningEffort === right.reasoningEffort &&
    left.stream === right.stream
  );
}

export function InferenceSettings({ profile }: InferenceSettingsProps) {
  const app = useApp();
  const capabilities = profile ? app.state.capabilities[profile.id] : undefined;
  const [draft, setDraft] = useState(profile?.defaultParams);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draftProfileId, setDraftProfileId] = useState(profile?.id);

  // Start a new draft when another profile is selected.
  if (profile?.id !== draftProfileId) {
    setDraftProfileId(profile?.id);
    setDraft(profile?.defaultParams);
    setProbeResult(null);
    setSaved(false);
  }

  if (!profile || !draft) {
    return (
      <div className="notice notice--info">
        <strong>No profile selected</strong>
        Select a connection profile to configure its inference parameters.
      </div>
    );
  }

  const streamingEnabled = Boolean(capabilities?.streamingVerified);
  const update = <K extends keyof InferenceParams>(key: K, value: InferenceParams[K]) => {
    setSaved(false);
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const effectiveStream = Boolean(draft.stream && streamingEnabled);
  const { omitted } = buildChatCompletionBody({
    model: profile.modelId || 'model',
    messages: [{ role: 'user', content: '' }],
    params: { ...draft, stream: effectiveStream },
    capabilities,
  });

  const dirty = !sameParams(
    { ...draft, stream: effectiveStream },
    { ...profile.defaultParams, stream: Boolean(profile.defaultParams.stream && streamingEnabled) },
  );

  const save = () => {
    app.saveProfile({
      ...profile,
      defaultParams: { ...draft, stream: effectiveStream },
      updatedAt: new Date().toISOString(),
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  const reset = () => {
    setDraft({
      maxTokens: LIMITS.maxTokens.default,
      temperature: LIMITS.temperature.default,
      topP: LIMITS.topP.default,
      frequencyPenalty: undefined,
      presencePenalty: undefined,
      reasoningEffort: null,
      stream: false,
    });
    setSaved(false);
  };

  const verifyStreaming = async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      const credential = resolveProfileCredential(profile, app.state);

      const result = await gateway.probeStreaming({
        baseUrl: effectiveProfileTarget(profile).baseUrl,
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
          ...(capabilities?.toolCalling ? { toolCalling: capabilities.toolCalling } : {}),
        },
      });
    } catch (error) {
      setProbeResult(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="settings-stack">
      <section className="card">
        <h3 className="card__title">Request parameters</h3>
        <p className="card__description">
          Sent with every request of <strong>{profile.name}</strong>. Values are clamped to the
          range the API accepts.
        </p>

        <div className="field">
          <label className="field__label" htmlFor="max-tokens">
            Maximum output tokens
          </label>
          <input
            id="max-tokens"
            type="number"
            min={LIMITS.maxTokens.min}
            max={LIMITS.maxTokens.max}
            value={draft.maxTokens}
            onChange={(event) =>
              update(
                'maxTokens',
                clamp(Number(event.target.value), LIMITS.maxTokens.min, LIMITS.maxTokens.max, draft.maxTokens),
              )
            }
          />
          <span className="field__hint">
            Upper bound for the generated answer ({LIMITS.maxTokens.min} –{' '}
            {LIMITS.maxTokens.max}). Larger values need more time and VRAM.
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
              min={LIMITS.temperature.min}
              max={LIMITS.temperature.max}
              step={0.05}
              value={draft.temperature}
              onChange={(event) => update('temperature', Number(event.target.value))}
            />
            <input
              type="number"
              aria-label="Temperature value"
              min={LIMITS.temperature.min}
              max={LIMITS.temperature.max}
              step={0.05}
              value={draft.temperature}
              onChange={(event) =>
                update(
                  'temperature',
                  clamp(Number(event.target.value), LIMITS.temperature.min, LIMITS.temperature.max, draft.temperature),
                )
              }
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
              min={LIMITS.topP.min}
              max={LIMITS.topP.max}
              step={0.01}
              value={draft.topP}
              onChange={(event) => update('topP', Number(event.target.value))}
            />
            <input
              type="number"
              aria-label="Top-p value"
              min={LIMITS.topP.min}
              max={LIMITS.topP.max}
              step={0.01}
              value={draft.topP}
              onChange={(event) =>
                update('topP', clamp(Number(event.target.value), LIMITS.topP.min, LIMITS.topP.max, draft.topP))
              }
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
              min={LIMITS.frequencyPenalty.min}
              max={LIMITS.frequencyPenalty.max}
              step={0.1}
              value={draft.frequencyPenalty}
              onChange={(event) =>
                update(
                  'frequencyPenalty',
                  clamp(
                    Number(event.target.value),
                    LIMITS.frequencyPenalty.min,
                    LIMITS.frequencyPenalty.max,
                    draft.frequencyPenalty ?? 0,
                  ),
                )
              }
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
              min={LIMITS.presencePenalty.min}
              max={LIMITS.presencePenalty.max}
              step={0.1}
              value={draft.presencePenalty}
              onChange={(event) =>
                update(
                  'presencePenalty',
                  clamp(
                    Number(event.target.value),
                    LIMITS.presencePenalty.min,
                    LIMITS.presencePenalty.max,
                    draft.presencePenalty ?? 0,
                  ),
                )
              }
            />
          ) : null}
        </div>
      </section>

      <section className="card">
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
                event.target.value === ''
                  ? null
                  : (event.target.value as ReasoningEffort),
              )
            }
            disabled={!capabilities?.reasoningEffortSupported}
          >
            <option value="">Do not send (server startup value is used)</option>
            {REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
          <span className="field__hint">
            {capabilities?.reasoningEffortSupported
              ? 'The connected server advertises a per-request reasoning_effort option.'
              : 'The connected server did not advertise this option, so the value is not sent.'}
          </span>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">Streaming</h3>
        <p className="card__description">
          Streaming needs a transport that supports Server-Sent Events. Cloudflare Quick Tunnels do
          not, which is why the option stays off until a real streaming request succeeds.
        </p>

        <label className="checkbox" htmlFor="streaming-enabled">
          <input
            id="streaming-enabled"
            type="checkbox"
            checked={effectiveStream}
            disabled={!streamingEnabled}
            onChange={(event) => update('stream', event.target.checked)}
          />
          <span>
            Stream the answer
            <span className="field__hint" style={{ display: 'block' }}>
              {streamingEnabled
                ? 'The endpoint delivered a text/event-stream response during verification.'
                : 'Disabled until streaming is verified for this endpoint in this session.'}
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
            role="status"
          >
            {probeResult}
          </div>
        ) : null}
      </section>

      <section className="card card--quiet">
        <h3 className="card__title">What is sent</h3>
        <p className="card__description">
          Unsupported parameters are omitted instead of being sent with a guessed value.
        </p>
        {omitted.length === 0 ? (
          <p className="text-subtle">Every configured parameter is sent with the request.</p>
        ) : (
          <p className="text-subtle">
            Not sent with the current settings: <code>{omitted.join(', ')}</code>.
          </p>
        )}
        {capabilities?.notes.length ? (
          <ul className="note-list">
            {capabilities.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card card--quiet">
        <h3 className="card__title">Server startup options</h3>
        <p className="card__description">
          These are set when the model server starts and cannot be changed from the browser.
        </p>
        <div className="notice">
          Context size, GPU layer split and speculative decoding (MTP) are start-up flags of
          <code> llama-server</code>. Restart the server with different values to change them.
        </div>
      </section>

      <div className="row row--between settings-actions">
        <button type="button" className="button" onClick={reset}>
          Reset to defaults
        </button>
        <div className="row">
          {dirty ? <span className="text-subtle">Unsaved changes</span> : null}
          <button type="button" className="button button--primary" onClick={save}>
            Save parameters
          </button>
        </div>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {saved ? 'The inference parameters were saved.' : ''}
      </p>
    </div>
  );
}
