/**
 * Domain model shared by the browser app and the local proxy backend.
 */

import type { InferenceParams, ServerCapabilities } from './api/requests';
import type { ApiErrorKind } from './api/errors';
import type { TokenUsage } from './api/types';

/**
 * How the API key for a profile is handled.
 *
 * - `session`  : kept in memory for the current page load only (default).
 * - `server`   : stored by the local proxy backend in a 0600 file, never in
 *                the browser.
 * - `browser`  : explicit opt-in, stored in browser local storage as plain
 *                text. The UI warns about this.
 */
export type CredentialStorage = 'session' | 'server' | 'browser';

export interface ApiProfile {
  id: string;
  /** Display name shown in the profile list. */
  name: string;
  /** Raw user input; normalized before use. */
  baseUrl: string;
  /** Model ID. May be empty, in which case the first model is discovered. */
  modelId: string;
  systemPrompt: string;
  timeoutMs: number;
  credentialStorage: CredentialStorage;
  /** Identifier of the key in the backend secret store (`server` mode only). */
  secretRef?: string;
  defaultParams: InferenceParams;
  createdAt: string;
  updatedAt: string;
}

export type MessageStatus = 'pending' | 'complete' | 'cancelled' | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  createdAt: string;
  model?: string;
  /** Only set when the server actually returned usage information. */
  usage?: TokenUsage;
  errorKind?: ApiErrorKind;
  errorMessage?: string;
  errorHint?: string;
  /** Chain-of-thought text, when the server returns it separately. */
  reasoning?: string;
  /** Finish reason reported by the server, for example `length`. */
  finishReason?: string;
  /**
   * How the answer actually arrived. Only set once the request finished, so
   * the interface never claims a stream that did not happen.
   */
  transport?: 'stream' | 'complete';
  /**
   * True when streaming was requested but the proxy had not verified it, and
   * the answer was fetched with a regular request instead.
   */
  streamFellBack?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  profileId: string | null;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export interface UiPreferences {
  activeProfileId: string | null;
  activeConversationId: string | null;
  theme: Theme;
  sendOnEnter: boolean;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  activeProfileId: null,
  activeConversationId: null,
  theme: 'system',
  sendOnEnter: true,
};

export type ConnectionStage =
  | 'transport'
  | 'auth'
  | 'models'
  | 'model'
  | 'inference'
  | 'streaming';

export type ConnectionStageStatus =
  | 'not_run'
  | 'running'
  | 'ok'
  | 'warning'
  | 'failed'
  | 'not_applicable';

export interface ConnectionStageResult {
  stage: ConnectionStage;
  status: ConnectionStageStatus;
  message: string;
  httpStatus?: number;
}

export interface ConnectionTestResult {
  /** True only when a real inference request succeeded. */
  ok: boolean;
  /** Effective, normalized base URL that was actually used. */
  baseUrl: string;
  /** The value the user typed, before normalization. */
  requestedBaseUrl?: string;
  /** True when normalization changed the value that was tested. */
  baseUrlChanged?: boolean;
  /** Model ID used for the inference probe. */
  modelId?: string;
  /** ISO timestamp of the test, produced by the proxy. */
  testedAt?: string;
  stages: ConnectionStageResult[];
  capabilities?: ServerCapabilities;
  errorKind?: ApiErrorKind;
  errorMessage?: string;
  errorHint?: string;
  /**
   * Client side identity of the configuration this result belongs to. It is
   * never persisted and never contains a credential. The chat only honours a
   * result whose fingerprint equals the active profile's current fingerprint.
   */
  configFingerprint?: string;
}
