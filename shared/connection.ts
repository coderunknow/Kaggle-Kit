/**
 * The connection identity of a profile.
 *
 * Settings, the connection test and the chat all have to agree on three
 * things: which profile is active, which base URL is really used after
 * normalization, and whether the last test belongs to that exact
 * configuration. This module is the single place where those answers are
 * derived. It contains no React and no network code, so the server tests and
 * the component tests can both use it.
 */

import { normalizeBaseUrlDetailed, UrlValidationError } from './api/url';
import type { ApiErrorKind } from './api/errors';
import type {
  ApiProfile,
  ConnectionStage,
  ConnectionStageResult,
  ConnectionStageStatus,
  ConnectionTestResult,
} from './domain';

export interface CredentialSnapshot {
  apiKey?: string;
  secretRef?: string;
}

export interface CredentialLookup {
  sessionKeys: Record<string, string>;
  browserKeys: Record<string, string>;
}

export interface EffectiveTarget {
  /** The value the user typed, trimmed. */
  requestedBaseUrl: string;
  /** The value that is really used: normalized, or the raw value if invalid. */
  baseUrl: string;
  /** True when normalization changed the input. */
  changed: boolean;
  notes: string[];
  /** Set when the value cannot be normalized. */
  error?: string;
}

/**
 * Resolve the credential of a profile from the app state. This is the only
 * implementation of the credential mode rules on the browser side; the chat
 * and the connection test both use it.
 */
export function resolveProfileCredential(
  profile: ApiProfile,
  lookup: CredentialLookup,
): CredentialSnapshot {
  switch (profile.credentialStorage) {
    case 'session':
      return { apiKey: lookup.sessionKeys[profile.id] };
    case 'browser':
      return { apiKey: lookup.browserKeys[profile.id] };
    case 'server':
      return { secretRef: profile.secretRef };
    default:
      return {};
  }
}

/** The base URL the application uses for this profile, plus what changed. */
export function effectiveProfileTarget(profile: ApiProfile): EffectiveTarget {
  const requestedBaseUrl = (profile.baseUrl ?? '').trim();
  try {
    const normalized = normalizeBaseUrlDetailed(profile.baseUrl);
    return {
      requestedBaseUrl,
      baseUrl: normalized.baseUrl,
      changed: normalized.changed,
      notes: normalized.notes,
    };
  } catch (error) {
    return {
      requestedBaseUrl,
      baseUrl: requestedBaseUrl,
      changed: false,
      notes: [],
      error:
        error instanceof UrlValidationError
          ? error.message
          : 'The base URL is not valid.',
    };
  }
}

/**
 * A stable identity of everything a connection test depends on.
 *
 * The key itself is never part of the fingerprint. Credential changes are
 * handled by invalidating the state when a key is written; a test that was
 * made with a key typed into the editor is kept local to the editor and is
 * never attached to the saved profile.
 */
export function profileFingerprint(
  profile: ApiProfile,
  credential: CredentialSnapshot,
): string {
  const keyPresent = credential.apiKey !== undefined && credential.apiKey !== '';
  const credentialIdentity =
    profile.credentialStorage === 'server'
      ? `server:${profile.secretRef ?? ''}`
      : profile.credentialStorage === 'browser'
        ? `browser:${keyPresent ? 'key' : 'none'}`
        : `session:${keyPresent ? 'key' : 'none'}`;

  return `${profileConfigFingerprint(profile)}\u0000${credentialIdentity}`;
}

/**
 * The configuration part of the fingerprint, without the credential.
 *
 * The profile editor uses this to decide whether a test that ran against
 * draft values can be attached to the profile that is about to be saved. The
 * secret reference is deliberately excluded: it is created while saving and
 * does not change which endpoint or model was tested.
 */
export function profileConfigFingerprint(profile: ApiProfile): string {
  const target = effectiveProfileTarget(profile);
  return [
    target.baseUrl,
    profile.modelId.trim(),
    String(profile.timeoutMs),
    profile.credentialStorage,
  ].join('\u0000');
}

export type ConnectionViewState =
  | 'missing'
  | 'untested'
  | 'connected'
  | 'failed'
  | 'stale';

export type ConnectionTone = 'ok' | 'danger' | 'warning' | 'neutral';

export interface ConnectionView {
  state: ConnectionViewState;
  label: string;
  tone: ConnectionTone;
  /** The stored test, only when it belongs to the current configuration. */
  test?: ConnectionTestResult;
  /** Fingerprint of the current configuration (undefined without a profile). */
  fingerprint?: string;
}

export const CONNECTION_STATE_LABELS: Record<ConnectionViewState, string> = {
  missing: 'No connection profile',
  untested: 'Not tested',
  connected: 'Connected',
  failed: 'Test failed',
  stale: 'Test needed',
};

const CONNECTION_STATE_TONES: Record<ConnectionViewState, ConnectionTone> = {
  missing: 'neutral',
  untested: 'warning',
  connected: 'ok',
  failed: 'danger',
  stale: 'warning',
};

export interface ConnectionStateSource extends CredentialLookup {
  connectionTests: Record<string, ConnectionTestResult | undefined>;
}

/**
 * Derive the state that every surface displays. A stored test is only used
 * when its fingerprint matches the current profile and credential, so editing
 * a URL, a model or a key can never leave a green "connected" state behind.
 */
export function resolveConnectionView(
  source: ConnectionStateSource,
  profile: ApiProfile | undefined,
): ConnectionView {
  if (!profile) {
    return { state: 'missing', label: CONNECTION_STATE_LABELS.missing, tone: 'neutral' };
  }

  const credential = resolveProfileCredential(profile, source);
  const fingerprint = profileFingerprint(profile, credential);
  const stored = source.connectionTests[profile.id];

  if (!stored || stored.configFingerprint === undefined) {
    return { state: 'untested', label: CONNECTION_STATE_LABELS.untested, tone: 'warning', fingerprint };
  }

  if (stored.configFingerprint !== fingerprint) {
    return { state: 'stale', label: CONNECTION_STATE_LABELS.stale, tone: 'warning', fingerprint };
  }

  const state: ConnectionViewState = stored.ok ? 'connected' : 'failed';
  return {
    state,
    label: CONNECTION_STATE_LABELS[state],
    tone: CONNECTION_STATE_TONES[state],
    test: stored,
    fingerprint,
  };
}

export const CONNECTION_STAGE_ORDER: readonly ConnectionStage[] = [
  'transport',
  'auth',
  'models',
  'model',
  'inference',
  'streaming',
];

export const CONNECTION_STAGE_LABELS: Record<ConnectionStage, string> = {
  transport: 'Reachability',
  auth: 'Authentication',
  models: 'Model list',
  model: 'Model',
  inference: 'Inference',
  streaming: 'Streaming',
};

export const CONNECTION_STAGE_STATUS_LABELS: Record<ConnectionStageStatus, string> = {
  not_run: 'not run',
  running: 'running',
  ok: 'ok',
  warning: 'warning',
  failed: 'failed',
  not_applicable: 'not applicable',
};

/** Find a stage result, independent of the order the proxy used. */
export function findStage(
  result: ConnectionTestResult | undefined,
  stage: ConnectionStage,
): ConnectionStageResult | undefined {
  return result?.stages.find((entry) => entry.stage === stage);
}

/**
 * Build a failure result when the local proxy itself could not run the test.
 * Keeping this shape identical to a proxy answer means Settings and the chat
 * classify the same failure the same way.
 */
export function connectionFailureResult(input: {
  requestedBaseUrl: string;
  baseUrl: string;
  baseUrlChanged: boolean;
  errorKind: ApiErrorKind;
  errorMessage: string;
  errorHint?: string;
  httpStatus?: number;
}): ConnectionTestResult {
  const failedStage: ConnectionStageResult = {
    stage: 'transport',
    status: 'failed',
    message: input.errorMessage,
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
  };

  const stages: ConnectionStageResult[] = [failedStage];
  for (const stage of CONNECTION_STAGE_ORDER) {
    if (stage === 'transport') continue;
    stages.push({
      stage,
      status: stage === 'streaming' ? 'not_run' : 'not_applicable',
      message:
        stage === 'streaming'
          ? 'Streaming was not checked because the connection test could not run.'
          : 'Not checked because the connection test could not run.',
    });
  }

  return {
    ok: false,
    baseUrl: input.baseUrl,
    requestedBaseUrl: input.requestedBaseUrl,
    baseUrlChanged: input.baseUrlChanged,
    testedAt: new Date().toISOString(),
    stages,
    errorKind: input.errorKind,
    errorMessage: input.errorMessage,
    ...(input.errorHint ? { errorHint: input.errorHint } : {}),
  };
}
