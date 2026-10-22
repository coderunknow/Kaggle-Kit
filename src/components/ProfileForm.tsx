/**
 * Profile editor.
 *
 * A profile describes one OpenAI-compatible endpoint: where it lives, how it
 * is authenticated and which model to talk to. The form is used both for
 * creating and for editing an existing profile.
 */

import { useMemo, useState } from 'react';

import { ApiError, describeErrorKind } from '../../shared/api/errors';
import { validateProfileDraft } from '../../shared/api/validation';
import type { ApiProfile, ConnectionTestResult, CredentialStorage } from '../../shared/domain';
import {
  CONNECTION_STAGE_LABELS,
  CONNECTION_STAGE_ORDER,
  CONNECTION_STAGE_STATUS_LABELS,
  connectionFailureResult,
  effectiveProfileTarget,
  profileConfigFingerprint,
  profileFingerprint,
  resolveProfileCredential,
  type CredentialSnapshot,
} from '../../shared/connection';
import {
  QWEN_SYSTEM_PROMPT,
  QWEN_SYSTEM_PROMPT_ID,
  QWEN_TOOL_SYSTEM_PROMPT_ID,
  estimatePromptTokens,
  qwenToolSystemPrompt,
} from '../../shared/prompts/qwen';
import {
  ACCELERATOR_LABELS,
  applyRecommendedParams,
  catalogEntryById,
  DEPLOYMENT_STATUS_LABELS,
  describeModelAvailability,
  findCatalogEntryByModelId,
  MODEL_CATALOG,
  type DeploymentStatus,
} from '../../shared/model-catalog/catalog';
import type { InferenceParams } from '../../shared/api/requests';
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
  advanced?: boolean;
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

/** The value of the model select that switches to the manual input. */
const CUSTOM_MODEL = '__custom__';

const DEPLOYMENT_TONES: Record<DeploymentStatus, 'ok' | 'warning' | 'danger' | 'neutral'> = {
  verified: 'ok',
  preexisting_not_reverified: 'neutral',
  implemented_not_live_verified: 'warning',
  blocked: 'danger',
  unsupported: 'danger',
  not_applicable: 'neutral',
};

const CREDENTIAL_LABELS: Record<CredentialStorage, string> = {
  session: 'This tab only (memory)',
  server: 'Local proxy secret store',
  browser: 'Browser storage (plain text)',
};

export function ProfileForm({ profile, isNew, onSaved, onCancel, onDeleted, advanced = true }: ProfileFormProps) {
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
  const [testResult, setTestResult] = useState<ConnectionTestResult | undefined>(() => {
    const stored = app.state.connectionTests[profile.id];
    const credential = resolveProfileCredential(profile, app.state);
    return stored && stored.configFingerprint === profileFingerprint(profile, credential)
      ? stored
      : undefined;
  });
  const [testedConfig, setTestedConfig] = useState<string | undefined>(() => {
    const stored = app.state.connectionTests[profile.id];
    const credential = resolveProfileCredential(profile, app.state);
    return stored && stored.configFingerprint === profileFingerprint(profile, credential)
      ? profileConfigFingerprint(profile)
      : undefined;
  });
  const [testAttached, setTestAttached] = useState(false);
  const [testSnapshot, setTestSnapshot] = useState<
    | {
        config: string;
        /** The key that was typed for the test; empty when the stored key was used. */
        typedKey: string;
        result: ConnectionTestResult;
      }
    | undefined
  >(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draftModels, setDraftModels] = useState<string[] | undefined>(undefined);
  // Sampling defaults are part of the draft so catalog recommendations are
  // saved with the profile (and only then). Editing them here never touches
  // the saved profile or any other profile.
  const [paramsDraft, setParamsDraft] = useState<InferenceParams>(() => ({ ...profile.defaultParams }));
  const [catalogId, setCatalogId] = useState<string>(
    () => findCatalogEntryByModelId(profile.modelId)?.id ?? '',
  );
  const [catalogNote, setCatalogNote] = useState<string | null>(null);

  const discoveredModels = draftModels ?? app.state.discoveredModels[profile.id] ?? [];

  // A model that is not in the discovered list can only be typed by hand.
  const [manualModel, setManualModel] = useState(
    () =>
      profile.modelId !== '' &&
      !(app.state.discoveredModels[profile.id] ?? []).includes(profile.modelId),
  );

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

  const ids = {
    name: `name-${profile.id}`,
    url: `url-${profile.id}`,
    urlHint: `url-hint-${profile.id}`,
    key: `key-${profile.id}`,
    credential: `cred-${profile.id}`,
    model: `model-${profile.id}`,
    modelHint: `model-hint-${profile.id}`,
    catalog: `catalog-${profile.id}`,
    catalogHint: `catalog-hint-${profile.id}`,
    system: `system-${profile.id}`,
    systemHint: `system-hint-${profile.id}`,
    timeout: `timeout-${profile.id}`,
    timeoutHint: `timeout-hint-${profile.id}`,
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const catalogEntry = catalogEntryById(catalogId);
  const recognizedEntry = findCatalogEntryByModelId(form.modelId);

  /**
   * Selecting a catalog entry only edits this draft: it fills the model ID
   * our deployments are known to serve (when there is one) and nothing else.
   * It never installs, downloads, starts, or switches a model on the server,
   * and it never overwrites a hand-typed model ID for entries whose served
   * ID is decided by discovery (Qwen/custom). A served ID is filled only
   * into an empty model field: a model ID the user already entered (for
   * example a hosted provider's own spelling) is kept, and replacing it is
   * an explicit, separate action.
   */
  const fillServedModelId = (servedId: string) => {
    update('modelId', servedId);
    setManualModel(discoveredModels.length > 0 && !discoveredModels.includes(servedId));
  };

  const selectCatalogEntry = (entryId: string) => {
    setCatalogId(entryId);
    setCatalogNote(null);
    const entry = catalogEntryById(entryId);
    if (!entry) return;
    const servedId = entry.servedModelIds[0];
    if (!servedId) return;
    const current = form.modelId.trim();
    if (!current) {
      fillServedModelId(servedId);
    } else if (current !== servedId) {
      setCatalogNote(
        `Kept your model ID "${current}". This project's ${entry.displayName} deployments serve "${servedId}"; use it only if this profile points at such a deployment.`,
      );
    }
  };

  const catalogServedId = catalogEntry?.servedModelIds[0];
  const offerServedId = Boolean(catalogServedId && form.modelId.trim() && form.modelId.trim() !== catalogServedId);

  const applyCatalogParams = (useCase: 'general' | 'coding_math') => {
    if (!catalogEntry) return;
    setParamsDraft((current) => applyRecommendedParams(current, catalogEntry, useCase));
    setCatalogNote(
      `Recommended ${catalogEntry.displayName} sampling (${useCase === 'coding_math' ? 'coding/math' : 'general'}) is in the draft. Save the profile to keep it; maximum output tokens and streaming were not changed.`,
    );
  };

  /** The credential that would be used for this form state. */
  const credentialFor = (): CredentialSnapshot => {
    switch (form.credentialStorage) {
      case 'session':
        return { apiKey: form.apiKey.trim() || app.state.sessionKeys[profile.id] };
      case 'browser':
        return { apiKey: form.apiKey.trim() || app.state.browserKeys[profile.id] };
      case 'server':
        // A key typed into the form is used directly for a test; it is only
        // written to the proxy secret store when the profile is saved.
        return form.apiKey.trim()
          ? { apiKey: form.apiKey.trim() }
          : { secretRef: profile.secretRef };
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
    defaultParams: { ...paramsDraft },
  });

  const savedCredential = resolveProfileCredential(profile, app.state);
  const savedFingerprint = profileFingerprint(profile, savedCredential);
  const savedConfig = profileConfigFingerprint(profile);
  const draftProfile = effectiveProfile();
  const draftConfig = profileConfigFingerprint(draftProfile);
  const typedKey = form.apiKey.trim();

  /**
   * A test may only update the stored state of the saved profile when it ran
   * against exactly that saved configuration and its saved credential. A
   * typed key, a new profile and any unsaved field make the result local to
   * this editor.
   */
  const canAttachTest =
    !isNew &&
    !typedKey &&
    form.credentialStorage === profile.credentialStorage &&
    draftConfig === savedConfig;

  const testIsCurrent = testResult !== undefined && testedConfig === draftConfig &&
    (testSnapshot ? testSnapshot.typedKey === typedKey : !typedKey);

  const handleSave = async () => {
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setNotes(validation.notes);
    setSaving(true);
    setFormError(null);

    const target = effectiveProfile();
    const usedTypedKey = Boolean(typedKey);

    try {
      const secretRef = await storeServerSecret();
      const savedProfile: ApiProfile = { ...target, secretRef };

      app.saveProfile(savedProfile);
      // A brand new profile becomes the active one so the chat can use it.
      // Editing an existing profile must not silently change the selection.
      if (isNew) app.selectProfile(target.id);

      if (form.credentialStorage === 'session' && typedKey) {
        app.setSessionKey(profile.id, typedKey);
      }
      if (form.credentialStorage === 'browser' && typedKey) {
        app.setBrowserKey(profile.id, typedKey);
      }

      // The result may only be attached when the credential that was tested
      // is exactly the credential that is now being saved.
      const sameCredential =
        testSnapshot !== undefined &&
        (testSnapshot.typedKey !== '' ? typedKey === testSnapshot.typedKey : typedKey === '');
      const matchingTest =
        testSnapshot !== undefined &&
        profileConfigFingerprint(savedProfile) === testSnapshot.config &&
        sameCredential;

      if (matchingTest && testSnapshot) {
        const savedCredentialForTest: CredentialSnapshot =
          savedProfile.credentialStorage === 'server'
            ? { secretRef }
            : {
                apiKey:
                  savedProfile.credentialStorage === 'browser'
                    ? app.state.browserKeys[profile.id] ?? typedKey
                    : app.state.sessionKeys[profile.id] ?? typedKey,
              };
        const fingerprint = profileFingerprint(savedProfile, savedCredentialForTest);

        // Dispatch after the profile and the key, so this result belongs to
        // the configuration that was just saved instead of being wiped by
        // the invalidation of the previous one.
        app.dispatch({
          type: 'connectionTest/set',
          profileId: profile.id,
          result: { ...testSnapshot.result, configFingerprint: fingerprint },
        });
        if (testSnapshot.result.capabilities) {
          app.dispatch({
            type: 'capabilities/set',
            profileId: profile.id,
            capabilities: testSnapshot.result.capabilities,
          });
        } else {
          app.dispatch({ type: 'capabilities/clear', profileId: profile.id });
        }
      } else if (form.credentialStorage === 'server' && usedTypedKey) {
        // The key was written but the test does not describe the saved
        // configuration. Never leave an older "connected" state behind.
        app.dispatch({ type: 'connection/invalidate', profileId: profile.id, models: true });
      }

      if (isNew && draftModels) {
        app.dispatch({ type: 'models/set', profileId: target.id, models: draftModels });
      }

      onSaved();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
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
    setFormError(null);

    const target = effectiveProfile();
    const credential = credentialFor();
    const usedTypedKey = Boolean(typedKey);
    const attach = canAttachTest;
    const attachFingerprint = savedFingerprint;

    try {
      const result = await gateway.testConnection({
        baseUrl: target.baseUrl,
        model: target.modelId || undefined,
        timeoutMs: target.timeoutMs,
        ...credential,
      });

      // The proxy used the first model when the profile had none. Reflect
      // that in the form so the saved profile names the model that was
      // actually tested.
      if (result.modelId && !target.modelId) {
        update('modelId', result.modelId);
      }

      const testedProfile: ApiProfile = {
        ...target,
        // A failed test may not name a model; keep the configured one so the
        // result still belongs to the configuration that was just tested.
        modelId: result.modelId || target.modelId,
      };

      setTestResult(result);
      setTestedConfig(profileConfigFingerprint(testedProfile));
      setTestAttached(attach);
      setTestSnapshot({
        config: profileConfigFingerprint(testedProfile),
        typedKey: usedTypedKey ? typedKey : '',
        result,
      });

      if (attach) {
        app.dispatch({
          type: 'connectionTest/set',
          profileId: profile.id,
          result: { ...result, configFingerprint: attachFingerprint },
        });
        if (result.capabilities) {
          app.dispatch({
            type: 'capabilities/set',
            profileId: profile.id,
            capabilities: result.capabilities,
          });
        } else {
          // A failed test must never leave a streaming verification behind.
          app.dispatch({ type: 'capabilities/clear', profileId: profile.id });
        }
      }
    } catch (error) {
      const apiError = error instanceof ApiError ? error : undefined;
      const targetInfo = effectiveProfileTarget(target);
      const failure = connectionFailureResult({
        requestedBaseUrl: targetInfo.requestedBaseUrl,
        baseUrl: targetInfo.baseUrl,
        baseUrlChanged: targetInfo.changed,
        errorKind: apiError?.kind ?? 'unknown',
        errorMessage:
          apiError?.message ?? (error instanceof Error ? error.message : String(error)),
        ...(apiError?.hint ? { errorHint: apiError.hint } : {}),
        ...(apiError?.httpStatus !== undefined ? { httpStatus: apiError.httpStatus } : {}),
      });

      setTestResult(failure);
      setTestedConfig(profileConfigFingerprint(target));
      setTestAttached(attach);
      setTestSnapshot({
        config: profileConfigFingerprint(target),
        typedKey: usedTypedKey ? typedKey : '',
        result: failure,
      });

      if (attach) {
        app.dispatch({
          type: 'connectionTest/set',
          profileId: profile.id,
          result: { ...failure, configFingerprint: attachFingerprint },
        });
        app.dispatch({ type: 'capabilities/clear', profileId: profile.id });
      }
    } finally {
      setTesting(false);
    }
  };

  const handleDiscover = async () => {
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setDiscovering(true);
    setFormError(null);

    const target = effectiveProfile();
    const credential = credentialFor();

    try {
      const models = await gateway.listModels({
        baseUrl: target.baseUrl,
        timeoutMs: target.timeoutMs,
        ...credential,
      });

      if (canAttachTest) {
        app.dispatch({ type: 'models/set', profileId: profile.id, models });
      } else {
        setDraftModels(models);
      }

      if (models.length === 0) {
        setFormError('The endpoint returned no model IDs. Enter the exact model ID manually, then test inference. Discovery alone does not verify a connection.');
      }
      if (models.length > 0 && !form.modelId) {
        update('modelId', models[0] as string);
        setManualModel(false);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
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
      className="card profile-form"
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

      {isNew ? <section className="notice notice--info" aria-label="Guided connection setup">
        <strong>Connect your model, then start chatting</strong>
        <ol>
          <li>Choose an endpoint type and enter its model API address below — not this page’s address.</li>
          <li>Enter a model-server key only if that server requires one. Built-in local tools need no provider account.</li>
          <li>Discover models, or enter the exact model ID manually.</li>
          <li>Test connection to verify actual inference, then save the profile.</li>
          <li>Start a conversation. Tools are an optional, separately verified opt-in.</li>
        </ol>
        <label className="field">
          <span className="field__label">Endpoint type (guidance only)</span>
          <select defaultValue="compatible" onChange={(event) => setNotes([
            event.target.value === 'kaggle'
              ? 'Kaggle: paste the current model API URL and key printed by your notebook. Tunnel addresses can change.'
              : event.target.value === 'local'
                ? 'Local server: use the address and port printed by your OpenAI-compatible server. Authentication depends on its configuration.'
                : 'OpenAI-compatible: use your provider’s API base URL and exact model ID; a model credential may be required.',
          ])}>
            <option value="compatible">OpenAI-compatible endpoint</option>
            <option value="kaggle">Kaggle notebook / tunnel</option>
            <option value="local">Local model server</option>
          </select>
        </label>
      </section> : null}

      <div className="field">
        <label className="field__label" htmlFor={ids.name}>
          Display name
        </label>
        <input
          id={ids.name}
          type="text"
          value={form.name}
          placeholder="Kaggle T4 x2"
          onChange={(event) => update('name', event.target.value)}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? `${ids.name}-error` : undefined}
        />
        {errors.name ? (
          <span className="field__error" id={`${ids.name}-error`}>
            {errors.name}
          </span>
        ) : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor={ids.url}>
          Base URL
        </label>
        <input
          id={ids.url}
          type="text"
          inputMode="url"
          value={form.baseUrl}
          placeholder="http://127.0.0.1:8000/v1"
          onChange={(event) => update('baseUrl', event.target.value)}
          aria-invalid={Boolean(errors.baseUrl)}
          aria-describedby={ids.urlHint}
        />
        <span className="field__hint" id={ids.urlHint}>
          The address of the <strong>model API</strong>, not of this page. The Kaggle notebook
          prints a <code>https://…trycloudflare.com</code> base URL; a local llama-server usually
          answers on <code>http://127.0.0.1:8000/v1</code>. A missing <code>/v1</code> is added
          automatically.
        </span>
        {validation.normalizedBaseUrl &&
        validation.normalizedBaseUrl !== form.baseUrl.trim() ? (
          <span className="field__hint">
            Entered: <code>{form.baseUrl.trim()}</code>
            <br />
            Effective base URL: <code>{validation.normalizedBaseUrl}</code> — the connection test
            and the chat use this value.
          </span>
        ) : null}
        {errors.baseUrl ? <span className="field__error">{errors.baseUrl}</span> : null}
      </div>

      <details className="help">
        <summary>Connection help (tunnel, allow list, Windows)</summary>
        <div className="help__body">
          <p>
            <strong>The local application address is not the model address.</strong> This page is
            served by the proxy on <code>http://127.0.0.1:8787</code>. A profile has to point at the
            model server, for example the Quick Tunnel URL from the notebook.
          </p>
          <p>
            <strong>Streaming.</strong> A Cloudflare Quick Tunnel does not support Server-Sent
            Events. The streaming switch stays off and the non streaming mode is used, which works
            through the tunnel.
          </p>
          <p>
            <strong>Upstream allow list.</strong> To restrict which hosts the proxy may reach, set
            <code> KAGGLE_KIT_ALLOWED_HOSTS</code> to a comma separated list of host names
            (<code>*.example.com</code> is supported) and restart the proxy, because the value is
            read at start-up. Without it the proxy can reach any host.
          </p>
          <pre className="help__code">
{`# PowerShell (Windows)
$env:KAGGLE_KIT_ALLOWED_HOSTS = "your-tunnel.trycloudflare.com"
npm start`}
          </pre>
          <p className="text-subtle">
            Use the host name of <em>your</em> tunnel, without a real one being stored here. The
            proxy has to be restarted after a change of this variable.
          </p>
        </div>
      </details>

      <div className="field">
        <label className="field__label" htmlFor={ids.key}>
          API key
        </label>
        <input
          id={ids.key}
          type="password"
          value={form.apiKey}
          autoComplete="off"
          placeholder={
            form.credentialStorage === 'server' && profile.secretRef
              ? 'A key is stored on the proxy; leave empty to keep it'
              : form.credentialStorage === 'server'
                ? 'Stored on the local proxy'
                : 'Paste the key printed by the notebook'
          }
          onChange={(event) => update('apiKey', event.target.value)}
        />
        <span className="field__hint">
          {form.credentialStorage === 'session'
            ? 'Kept in memory for this tab only. It disappears when you reload the page.'
            : form.credentialStorage === 'server'
              ? 'Stored by the local proxy in a 0600 file. It never reaches browser storage.'
              : 'Stored as plain text in this browser. Only use this on a trusted machine.'}
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={ids.credential}>
          Where the key is kept
        </label>
        <select
          id={ids.credential}
          value={form.credentialStorage}
          onChange={(event) => update('credentialStorage', event.target.value as CredentialStorage)}
        >
          {(Object.keys(CREDENTIAL_LABELS) as CredentialStorage[]).map((mode) => (
            <option key={mode} value={mode}>
              {CREDENTIAL_LABELS[mode]}
            </option>
          ))}
        </select>
        {form.credentialStorage === 'browser' ? (
          <span className="field__error">
            Browser storage is readable by any script on this origin. This is an explicit opt-in.
          </span>
        ) : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor={ids.catalog}>
          Known models (catalog)
        </label>
        <select
          id={ids.catalog}
          value={catalogId}
          aria-describedby={ids.catalogHint}
          onChange={(event) => selectCatalogEntry(event.target.value)}
        >
          <option value="">(browse the catalog — no selection)</option>
          {MODEL_CATALOG.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.displayName}
            </option>
          ))}
        </select>
        <span className="field__hint" id={ids.catalogHint}>
          The catalog is metadata plus deployment guidance. Selecting an entry fills draft fields
          only — it does not install, download, start, or switch a model on any server. Only
          “Discover models” and a real connection test prove what this endpoint serves.
          {recognizedEntry && recognizedEntry.id !== catalogId
            ? ` The current model ID is recognized as ${recognizedEntry.displayName}.`
            : ''}
        </span>
        {catalogEntry ? (
          <div className="notice notice--info" style={{ marginTop: 8 }}>
            <strong>{catalogEntry.displayName}</strong>
            {catalogEntry.description}
            <div className="text-subtle" style={{ marginTop: 6 }}>
              {catalogEntry.architecture}
              {catalogEntry.totalParameters ? ` · ${catalogEntry.totalParameters} total` : ''}
              {catalogEntry.activeParameters ? ` · ${catalogEntry.activeParameters} active per token` : ''}
              {catalogEntry.contextTokens ? ` · ${catalogEntry.contextTokens.toLocaleString()} token context` : ''}
              {catalogEntry.license ? ` · ${catalogEntry.license}` : ''}
            </div>
            <div style={{ marginTop: 6 }}>{catalogEntry.accessNote}</div>
            <ul className="result-list" style={{ marginTop: 8 }}>
              {catalogEntry.deployments.map((deployment) => (
                <li key={deployment.accelerator} className="result-item">
                  <div className="result-item__label">
                    <Badge tone={DEPLOYMENT_TONES[deployment.status]}>
                      {DEPLOYMENT_STATUS_LABELS[deployment.status]}
                    </Badge>
                    <span>{ACCELERATOR_LABELS[deployment.accelerator]}</span>
                  </div>
                  <div className="text-subtle">{deployment.runtime}</div>
                </li>
              ))}
            </ul>
            <div role="status" style={{ marginTop: 6 }}>
              {describeModelAvailability(catalogEntry, discoveredModels).message}
            </div>
            {offerServedId && catalogServedId ? (
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" className="button button--small" onClick={() => { fillServedModelId(catalogServedId); setCatalogNote(null); }}>
                  Use {catalogServedId}
                </button>
              </div>
            ) : null}
            {catalogEntry.recommendedParams ? (
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" className="button button--small" onClick={() => applyCatalogParams('general')}>
                  Apply recommended sampling
                </button>
                {catalogEntry.codingMathParams ? (
                  <button type="button" className="button button--small" onClick={() => applyCatalogParams('coding_math')}>
                    Apply coding/math variant
                  </button>
                ) : null}
              </div>
            ) : null}
            {catalogNote ? (
              <div className="text-subtle" role="status" style={{ marginTop: 6 }}>
                {catalogNote}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor={ids.model}>
          Model ID
        </label>
        {discoveredModels.length > 0 ? (
          <>
            <select
              id={ids.model}
              value={manualModel ? CUSTOM_MODEL : form.modelId}
              aria-describedby={ids.modelHint}
              onChange={(event) => {
                if (event.target.value === CUSTOM_MODEL) {
                  setManualModel(true);
                  return;
                }
                setManualModel(false);
                update('modelId', event.target.value);
              }}
            >
              <option value="">(first model returned by the server)</option>
              {discoveredModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
              <option value={CUSTOM_MODEL}>another model ID (type it)</option>
            </select>
            {manualModel ? (
              <>
                <label className="field__label field__label--sub" htmlFor={`${ids.model}-custom`}>
                  Model ID (typed by hand)
                </label>
                <input
                  id={`${ids.model}-custom`}
                  type="text"
                  value={form.modelId}
                  placeholder="the model ID of the server"
                  onChange={(event) => update('modelId', event.target.value)}
                />
              </>
            ) : null}
          </>
        ) : (
          <input
            id={ids.model}
            type="text"
            value={form.modelId}
            placeholder="leave empty to use the first model of the server"
            aria-describedby={ids.modelHint}
            onChange={(event) => update('modelId', event.target.value)}
          />
        )}
        <span className="field__hint" id={ids.modelHint}>
          {discoveredModels.length > 0
            ? 'Discovered from /v1/models. Run “Discover models” again to refresh, or type another model ID.'
            : 'Type the model ID manually, or use “Discover models” to read it from the server.'}
        </span>
      </div>

      <div className="field" hidden={!advanced}>
        <label className="field__label" htmlFor={ids.system}>
          System prompt
        </label>
        <textarea
          id={ids.system}
          value={form.systemPrompt}
          placeholder="Optional instructions sent with every message."
          aria-describedby={ids.systemHint}
          onChange={(event) => update('systemPrompt', event.target.value)}
        />
        <span className="field__hint" id={ids.systemHint}>
          Sent as the first message of every request.
          {form.systemPrompt.trim()
            ? ` ${form.systemPrompt.length} characters, roughly ${estimatePromptTokens(form.systemPrompt)} tokens of the 8192 that the deployed server allocates to the whole conversation.`
            : ''}
        </span>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="button button--small"
            onClick={() => update('systemPrompt', QWEN_SYSTEM_PROMPT)}
          >
            {form.systemPrompt.trim() ? 'Replace with the recommended Qwen prompt' : 'Insert the recommended Qwen prompt'}
          </button>
          <button
            type="button"
            className="button button--small"
            onClick={() => update('systemPrompt', qwenToolSystemPrompt())}
          >
            Insert the tool-use variant
          </button>
        </div>
        <span className="field__hint">
          The base prompt ({QWEN_SYSTEM_PROMPT_ID}) describes ordinary chat without tools and is the
          truthful default. The tool-use variant ({QWEN_TOOL_SYSTEM_PROMPT_ID}) replaces that claim
          with guidance for the verified native protocol — use it only for profiles where tool
          calling passed the probe in Tools settings. The texts live in{' '}
          <code>shared/prompts/qwen.ts</code>; the research behind the base prompt is in{' '}
          <code>research/qwen-system-prompt/</code>.
        </span>
      </div>

      <div className="field" hidden={!advanced}>
        <label className="field__label" htmlFor={ids.timeout}>
          Request timeout (ms)
        </label>
        <input
          id={ids.timeout}
          type="number"
          min={1000}
          max={1800000}
          step={1000}
          value={form.timeoutMs}
          onChange={(event) => update('timeoutMs', event.target.value)}
          aria-invalid={Boolean(errors.timeoutMs)}
          aria-describedby={ids.timeoutHint}
        />
        <span className="field__hint" id={ids.timeoutHint}>
          1 000 – 1 800 000. 120 000 ms = 2 minutes. Long answers on a T4 need a generous value.
        </span>
        {errors.timeoutMs ? <span className="field__error">{errors.timeoutMs}</span> : null}
      </div>

      {notes.length > 0 ? (
        <div className="notice notice--info" style={{ marginBottom: 16 }}>
          {notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      ) : null}

      <div className="row form-actions">
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
        <span className="text-subtle">
          Tests use the values above. A test of unsaved values is shown here only; it does not
          change the saved profile&apos;s status.
        </span>
      </div>

      {formError ? (
        <div className="notice notice--danger" style={{ marginBottom: 12 }}>
          <strong>The action could not be completed</strong>
          {formError}
        </div>
      ) : null}

      {testResult && !testIsCurrent ? (
        <div className="notice notice--info" style={{ marginBottom: 12 }}>
          <strong>The form changed since the last test</strong>
          Run <em>Test connection</em> again to check the values that are shown now.
        </div>
      ) : null}

      {testResult && testIsCurrent ? (
        <>
          {!testAttached ? (
            <div className="notice notice--info" style={{ marginBottom: 12 }}>
              <strong>This test used unsaved values</strong>
              Save the profile to use this configuration. The saved profile keeps its previous
              status until then.
            </div>
          ) : null}
          <TestResultView result={testResult} />
        </>
      ) : null}

      <div className="row row--between form-footer">
        {isNew ? (
          <span />
        ) : confirmDelete ? (
          <div className="row">
            <span className="text-small">Delete this profile?</span>
            <button type="button" className="button button--danger button--small" onClick={handleDelete}>
              Yes, delete
            </button>
            <button type="button" className="button button--small" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="button button--danger button--small"
            onClick={() => setConfirmDelete(true)}
          >
            <Icon name="trash" size={13} />
            Delete profile
          </button>
        )}
        <div className="row">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={saving || testing || discovering}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </div>
    </form>
  );
}

export function TestResultView({ result }: { result: ConnectionTestResult }) {
  const orderedStages = CONNECTION_STAGE_ORDER.map((stage) =>
    result.stages.find((entry) => entry.stage === stage),
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const streaming = result.stages.find((entry) => entry.stage === 'streaming');

  return (
    <div className="test-result" aria-live="polite">
      <div className="row">
        <Badge tone={result.ok ? 'ok' : 'danger'}>
          {result.ok ? 'Connected' : 'Connection failed'}
        </Badge>
        {result.ok ? <Badge tone="info">inference verified</Badge> : null}
        {result.modelId ? <Badge tone="info">model: {result.modelId}</Badge> : null}
        {streaming?.status === 'ok' ? (
          <Badge tone="ok">streaming verified</Badge>
        ) : (
          <Badge tone="neutral">streaming not verified</Badge>
        )}
      </div>

      {result.baseUrl ? (
        <div className="field__hint">
          Tested endpoint: <code>{result.baseUrl}</code>
          {result.baseUrlChanged && result.requestedBaseUrl ? (
            <>
              <br />
              Entered: <code>{result.requestedBaseUrl}</code> (normalized before the test)
            </>
          ) : null}
          {result.testedAt ? (
            <>
              <br />
              Tested at {new Date(result.testedAt).toLocaleString()}
            </>
          ) : null}
        </div>
      ) : null}

      <ul className="result-list">
        {orderedStages.map((stage) => (
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
                {CONNECTION_STAGE_LABELS[stage.stage]}
              </Badge>
              <span className="text-subtle">
                {CONNECTION_STAGE_STATUS_LABELS[stage.status]}
              </span>
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
