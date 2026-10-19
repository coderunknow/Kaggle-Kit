/**
 * Profile editor.
 *
 * A profile describes one OpenAI-compatible endpoint: where it lives, how it
 * is authenticated and which model to talk to. The form is used both for
 * creating and for editing an existing profile.
 */

import { useMemo, useState } from 'react';

import { describeErrorKind } from '../../shared/api/errors';
import type { ServerCapabilities } from '../../shared/api/requests';
import type { ApiProfile, ConnectionTestResult, CredentialStorage } from '../../shared/domain';
import { validateProfileDraft } from '../../shared/api/validation';
import { QWEN_SYSTEM_PROMPT, QWEN_SYSTEM_PROMPT_ID, estimatePromptTokens } from '../../shared/prompts/qwen';
import { gateway } from '../lib/gateway';
import { createId } from '../lib/id';
import { useApp } from '../state/AppProvider';
import { Badge, Icon } from './ui';

export interface ProfileFormProps {
  profile: ApiProfile;
  isNew: boolean;
  onSaved: () => void;
  onCancel: () => void;
  onDeleted: () => void;
}

interface FormState {
  name: string;
  baseUrl: string;
  modelId: string;
  systemPrompt: string;
  timeoutMs: string;
  credentialStorage: CredentialStorage;
  apiKey: string;
}

const CREDENTIAL_LABELS: Record<CredentialStorage, string> = {
  session: 'This tab only (memory)',
  server: 'Local proxy secret store',
  browser: 'Browser storage (plain text)',
};

export function ProfileForm({ profile, isNew, onSaved, onCancel, onDeleted }: ProfileFormProps) {
  const app = useApp();
  // The form is mounted with the key of the profile, so a new profile always
  // starts with a fresh form.
  const [form, setForm] = useState<FormState>(() => ({
    name: profile.name,
    baseUrl: profile.baseUrl,
    modelId: profile.modelId,
    systemPrompt: profile.systemPrompt,
    timeoutMs: String(profile.timeoutMs),
    credentialStorage: profile.credentialStorage,
    apiKey: '',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | undefined>(
    app.state.connectionTests[profile.id],
  );
  const [testError, setTestError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);

  const discoveredModels = app.state.discoveredModels[profile.id] ?? [];

  const timeoutValue = Number.parseInt(form.timeoutMs, 10);

  const validation = useMemo(
    () =>
      validateProfileDraft({
        name: form.name,
        baseUrl: form.baseUrl,
        modelId: form.modelId,
        systemPrompt: form.systemPrompt,
        timeoutMs: Number.isFinite(timeoutValue) ? timeoutValue : Number.NaN,
        credentialStorage: form.credentialStorage,
      }),
    [form, timeoutValue],
  );

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  /** The credential that would be used for this form state. */
  const credentialFor = (): { apiKey?: string; secretRef?: string } => {
    switch (form.credentialStorage) {
      case 'session':
        return { apiKey: form.apiKey.trim() || app.state.sessionKeys[profile.id] };
      case 'browser':
        return { apiKey: form.apiKey.trim() || app.state.browserKeys[profile.id] };
      case 'server':
        return { secretRef: profile.secretRef };
      default:
        return {};
    }
  };

  /**
   * In the "server" mode the key lives in the backend, so a key that was
   * typed into the form has to be stored there before it can be used.
   */
  const storeServerSecret = async (): Promise<string | undefined> => {
    if (form.credentialStorage !== 'server') return profile.secretRef;
    if (!form.apiKey.trim()) return profile.secretRef;

    const reference = profile.secretRef ?? createId('secret');
    await gateway.saveSecret(reference, form.apiKey.trim());
    return reference;
  };

  const effectiveProfile = (): ApiProfile => ({
    ...profile,
    name: form.name.trim(),
    baseUrl: validation.normalizedBaseUrl ?? form.baseUrl,
    modelId: form.modelId.trim(),
    systemPrompt: form.systemPrompt,
    timeoutMs: Number.isFinite(timeoutValue) ? timeoutValue : profile.timeoutMs,
    credentialStorage: form.credentialStorage,
  });

  const handleSave = async () => {
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setNotes(validation.notes);
    setSaving(true);

    const target = effectiveProfile();

    try {
      const secretRef = await storeServerSecret();

      app.saveProfile({ ...target, secretRef });
      // A newly saved profile becomes the active one so the chat can use it.
      app.selectProfile(target.id);

      if (form.credentialStorage === 'session' && form.apiKey.trim()) {
        app.setSessionKey(profile.id, form.apiKey.trim());
      }
      if (form.credentialStorage === 'browser' && form.apiKey.trim()) {
        app.setBrowserKey(profile.id, form.apiKey.trim());
      }

      onSaved();
    } catch (error) {
      setTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setTesting(true);
    setTestError(null);

    const target = effectiveProfile();

    try {
      const secretRef = await storeServerSecret();
      const credential =
        secretRef && secretRef !== profile.secretRef
          ? { secretRef }
          : credentialFor();

      const result = await gateway.testConnection({
        baseUrl: target.baseUrl,
        model: target.modelId || undefined,
        timeoutMs: target.timeoutMs,
        ...credential,
      });

      setTestResult(result);
      app.dispatch({ type: 'connectionTest/set', profileId: profile.id, result });

      if (result.capabilities) {
        app.dispatch({
          type: 'capabilities/set',
          profileId: profile.id,
          capabilities: result.capabilities,
        });
      }

      if (result.modelId && !target.modelId) {
        update('modelId', result.modelId);
      }
    } catch (error) {
      setTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setTestError(null);

    try {
      const secretRef = await storeServerSecret();
      const credential =
        secretRef && secretRef !== profile.secretRef
          ? { secretRef }
          : credentialFor();

      const models = await gateway.listModels({
        baseUrl: validation.normalizedBaseUrl ?? form.baseUrl,
        timeoutMs: profile.timeoutMs,
        ...credential,
      });
      app.dispatch({ type: 'models/set', profileId: profile.id, models });
      if (models.length > 0 && !form.modelId) {
        update('modelId', models[0] as string);
      }
    } catch (error) {
      setTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiscovering(false);
    }
  };

  const handleDelete = () => {
    if (profile.secretRef) {
      void gateway.deleteSecret(profile.secretRef).catch(() => undefined);
    }
    app.deleteProfile(profile.id);
    onDeleted();
  };

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <div className="row row--between">
        <h3 className="card__title">{isNew ? 'New connection profile' : 'Edit connection profile'}</h3>
        <button type="button" className="button button--ghost button--icon" aria-label="Close the editor" onClick={onCancel}>
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`name-${profile.id}`}>
          Display name
        </label>
        <input
          id={`name-${profile.id}`}
          type="text"
          value={form.name}
          placeholder="Kaggle T4 x2"
          onChange={(event) => update('name', event.target.value)}
          aria-invalid={Boolean(errors.name)}
        />
        {errors.name ? <span className="field__error">{errors.name}</span> : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`url-${profile.id}`}>
          Base URL
        </label>
        <input
          id={`url-${profile.id}`}
          type="text"
          inputMode="url"
          value={form.baseUrl}
          placeholder="http://127.0.0.1:8000/v1"
          onChange={(event) => update('baseUrl', event.target.value)}
          aria-invalid={Boolean(errors.baseUrl)}
          aria-describedby={`url-hint-${profile.id}`}
        />
        <span className="field__hint" id={`url-hint-${profile.id}`}>
          The OpenAI-compatible base URL of your server. A missing <code>/v1</code> is added
          automatically.
        </span>
        {errors.baseUrl ? <span className="field__error">{errors.baseUrl}</span> : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`key-${profile.id}`}>
          API key
        </label>
        <input
          id={`key-${profile.id}`}
          type="password"
          value={form.apiKey}
          autoComplete="off"
          placeholder={form.credentialStorage === 'server' ? 'Stored on the local proxy' : 'Paste the key printed by the notebook'}
          onChange={(event) => update('apiKey', event.target.value)}
        />
        <span className="field__hint">
          {form.credentialStorage === 'session'
            ? 'Kept in memory for this tab only. It disappears when you reload the page.'
            : form.credentialStorage === 'server'
              ? 'Stored by the local proxy in a 0600 file. It never reaches the browser storage.'
              : 'Stored as plain text in this browser. Only use this on a trusted machine.'}
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`cred-${profile.id}`}>
          Where the key is kept
        </label>
        <select
          id={`cred-${profile.id}`}
          value={form.credentialStorage}
          onChange={(event) => update('credentialStorage', event.target.value as CredentialStorage)}
        >
          {(Object.keys(CREDENTIAL_LABELS) as CredentialStorage[]).map((mode) => (
            <option key={mode} value={mode}>
              {CREDENTIAL_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`model-${profile.id}`}>
          Model ID
        </label>
        {discoveredModels.length > 0 ? (
          <select
            id={`model-${profile.id}`}
            value={form.modelId}
            onChange={(event) => update('modelId', event.target.value)}
          >
            <option value="">(first model returned by the server)</option>
            {discoveredModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`model-${profile.id}`}
            type="text"
            value={form.modelId}
            placeholder="leave empty to use the first model of the server"
            onChange={(event) => update('modelId', event.target.value)}
          />
        )}
        <span className="field__hint">
          {discoveredModels.length > 0
            ? 'Discovered from /v1/models. Use "Discover models" again to refresh.'
            : 'Type the model ID manually, or use "Discover models" to read it from the server.'}
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`system-${profile.id}`}>
          System prompt
        </label>
        <textarea
          id={`system-${profile.id}`}
          value={form.systemPrompt}
          placeholder="Optional instructions sent with every message."
          onChange={(event) => update('systemPrompt', event.target.value)}
        />
        <span className="field__hint">
          Sent as the first message of every request.
          {form.systemPrompt.trim()
            ? ` ${form.systemPrompt.length} characters, roughly ${estimatePromptTokens(form.systemPrompt)} tokens of the 8192 that the deployed server allocates to the whole conversation.`
            : ''}
        </span>
        <button
          type="button"
          className="button button--small"
          onClick={() => update('systemPrompt', QWEN_SYSTEM_PROMPT)}
        >
          {form.systemPrompt.trim() ? 'Replace with the recommended Qwen prompt' : 'Insert the recommended Qwen prompt'}
        </button>
        <span className="field__hint">
          Tuned for the {QWEN_SYSTEM_PROMPT_ID} target: no tools, one system message. The text is in
          <code> shared/prompts/qwen.ts</code>; the research behind it is in
          <code> research/qwen-system-prompt/</code>.
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`timeout-${profile.id}`}>
          Request timeout (ms)
        </label>
        <input
          id={`timeout-${profile.id}`}
          type="number"
          min={1000}
          max={1800000}
          step={1000}
          value={form.timeoutMs}
          onChange={(event) => update('timeoutMs', event.target.value)}
          aria-invalid={Boolean(errors.timeoutMs)}
        />
        {errors.timeoutMs ? <span className="field__error">{errors.timeoutMs}</span> : null}
      </div>

      {notes.length > 0 ? (
        <div className="notice notice--info" style={{ marginBottom: 16 }}>
          {notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      ) : null}

      <div className="row" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="button button--small"
          onClick={() => void handleTest()}
          disabled={testing || saving}
        >
          <Icon name="server" size={13} />
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => void handleDiscover()}
          disabled={discovering || testing}
        >
          <Icon name="refresh" size={13} />
          {discovering ? 'Loading…' : 'Discover models'}
        </button>
      </div>

      {testError ? (
        <div className="notice notice--danger" style={{ marginBottom: 12 }}>
          <strong>The test could not be completed</strong>
          {testError}
        </div>
      ) : null}

      {testResult ? <TestResultView result={testResult} /> : null}

      <div className="row row--between" style={{ marginTop: 16 }}>
        <button type="button" className="button button--danger button--small" onClick={handleDelete}>
          <Icon name="trash" size={13} />
          Delete profile
        </button>
        <div className="row">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </div>
    </form>
  );
}

export function TestResultView({ result }: { result: ConnectionTestResult }) {
  return (
    <div className="stack stack--tight" style={{ marginBottom: 12 }}>
      <div className="row">
        <Badge tone={result.ok ? 'ok' : 'danger'}>
          {result.ok ? 'Connection works' : 'Connection failed'}
        </Badge>
        {result.modelId ? <Badge tone="info">model: {result.modelId}</Badge> : null}
        {result.capabilities?.streamingVerified ? <Badge tone="ok">streaming verified</Badge> : null}
      </div>

      <ul className="result-list">
        {result.stages.map((stage) => (
          <li key={stage.stage} className="result-item">
            <div className="result-item__label">
              <Badge
                tone={
                  stage.status === 'ok'
                    ? 'ok'
                    : stage.status === 'warning'
                      ? 'warning'
                      : stage.status === 'failed'
                        ? 'danger'
                        : 'neutral'
                }
              >
                {stage.stage}
              </Badge>
              {stage.httpStatus ? <span className="text-subtle">HTTP {stage.httpStatus}</span> : null}
            </div>
            <div>{stage.message}</div>
          </li>
        ))}
      </ul>

      {!result.ok && result.errorMessage ? (
        <div className="notice notice--danger">
          <strong>{describeErrorKind(result.errorKind ?? 'unknown')}</strong>
          {result.errorMessage}
          {result.errorHint ? <div className="text-subtle">{result.errorHint}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export type { ServerCapabilities };
