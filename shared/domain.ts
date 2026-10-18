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
}

export interface Conversation {
  id: string;
  title: string;
  profileId: string | null;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface UiPreferences {
  activeProfileId: string | null;
  activeConversationId: string | null;
  theme: 'system' | 'light' | 'dark';
  sendOnEnter: boolean;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  activeProfileId: null,
  activeConversationId: null,
  theme: 'system',
  sendOnEnter: true,
};

export type ConnectionStage = 'models' | 'inference';

export type ConnectionStageStatus = 'ok' | 'warning' | 'failed' | 'skipped';

export interface ConnectionStageResult {
  stage: ConnectionStage;
  status: ConnectionStageStatus;
  message: string;
  httpStatus?: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Normalized base URL that was actually used. */
  baseUrl: string;
  /** Model ID used for the inference probe. */
  modelId?: string;
  stages: ConnectionStageResult[];
  capabilities?: ServerCapabilities;
  errorKind?: ApiErrorKind;
  errorMessage?: string;
  errorHint?: string;
}
