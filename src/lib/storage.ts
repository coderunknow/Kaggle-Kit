/**
 * Browser storage helpers.
 *
 * Only non-sensitive data is persisted by default:
 *  - API profiles (without any key material)
 *  - conversation history
 *  - UI preferences
 *
 * API keys are only written to browser storage when the user explicitly opts
 * into the "browser" credential mode, and the key material lives in a
 * separate store so it can be wiped independently.
 */

import type { ApiProfile, Conversation, UiPreferences } from '../../shared/domain';
import { DEFAULT_UI_PREFERENCES } from '../../shared/domain';

export const STORAGE_KEYS = {
  profiles: 'kaggle-kit.profiles.v1',
  conversations: 'kaggle-kit.conversations.v1',
  preferences: 'kaggle-kit.prefs.v1',
  /** Opt-in only: plain text API keys in the browser. */
  browserKeys: 'kaggle-kit.browser-keys.v1',
} as const;

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 500;

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const store = storage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Storage quota exceeded or storage disabled: keep the app usable.
  }
}

export function removeKey(key: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Remove every key this application owns. */
export function clearAllStoredData(): void {
  for (const key of Object.values(STORAGE_KEYS)) {
    removeKey(key);
  }
}

export function loadProfiles(): ApiProfile[] {
  const value = readJson<ApiProfile[]>(STORAGE_KEYS.profiles, []);
  if (!Array.isArray(value)) return [];
  return value
    .filter((profile): profile is ApiProfile => Boolean(profile) && typeof profile === 'object')
    .map((profile) => ({
      ...profile,
      // Defensive: a key must never be part of a persisted profile.
      ...(Object.prototype.hasOwnProperty.call(profile, 'apiKey')
        ? { apiKey: undefined }
        : {}),
    }));
}

export function saveProfiles(profiles: ApiProfile[]): void {
  writeJson(
    STORAGE_KEYS.profiles,
    profiles.map(({ ...profile }) => profile),
  );
}

export function loadConversations(): Conversation[] {
  const value = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
  if (!Array.isArray(value)) return [];
  return value
    .filter((conversation): conversation is Conversation =>
      Boolean(conversation) && typeof conversation === 'object' && Array.isArray(conversation.messages),
    )
    .map((conversation) => ({
      ...conversation,
      messages: conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
    }));
}

export function saveConversations(conversations: Conversation[]): void {
  writeJson(STORAGE_KEYS.conversations, conversations.slice(0, MAX_CONVERSATIONS));
}

export function loadPreferences(): UiPreferences {
  const value = readJson<Partial<UiPreferences>>(STORAGE_KEYS.preferences, {});
  return { ...DEFAULT_UI_PREFERENCES, ...value };
}

export function savePreferences(preferences: UiPreferences): void {
  writeJson(STORAGE_KEYS.preferences, preferences);
}

/** Plain text keys, only written when the user opts into browser storage. */
export function loadBrowserKeys(): Record<string, string> {
  const value = readJson<Record<string, string>>(STORAGE_KEYS.browserKeys, {});
  if (!value || typeof value !== 'object') return {};
  return value;
}

export function saveBrowserKeys(keys: Record<string, string>): void {
  writeJson(STORAGE_KEYS.browserKeys, keys);
}
