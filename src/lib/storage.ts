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

import type {
  ApiProfile,
  ChatMessage,
  Conversation,
  MessageStatus,
  UiPreferences,
} from '../../shared/domain';
import { DEFAULT_UI_PREFERENCES, THEMES } from '../../shared/domain';

export const STORAGE_KEYS = {
  profiles: 'kaggle-kit.profiles.v1',
  conversations: 'kaggle-kit.conversations.v1',
  preferences: 'kaggle-kit.prefs.v1',
  /** Opt-in only: plain text API keys in the browser. */
  browserKeys: 'kaggle-kit.browser-keys.v1',
  /** Unsent text per conversation, so a reload does not lose a draft. */
  drafts: 'kaggle-kit.drafts.v1',
} as const;

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 500;
const MAX_DRAFTS = 50;
const MAX_DRAFT_LENGTH = 20_000;

const MESSAGE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'complete',
  'cancelled',
  'error',
]);

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

/**
 * Make one stored message safe to render.
 *
 * Stored data can be old, hand edited or damaged. A message without a role,
 * a string content or an identifier is dropped; optional fields are only
 * copied when they have the expected type.
 */
export function sanitizeStoredMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.role !== 'user' && value.role !== 'assistant') return null;
  if (typeof value.content !== 'string') return null;
  if (typeof value.id !== 'string' || value.id === '') return null;

  const storedStatus = typeof value.status === 'string' ? value.status : 'complete';
  // A message that was still pending when the tab was closed can never
  // finish. Showing it as cancelled is truthful and keeps the text.
  const status: MessageStatus =
    storedStatus === 'pending'
      ? 'cancelled'
      : MESSAGE_STATUSES.has(storedStatus)
        ? (storedStatus as MessageStatus)
        : 'complete';

  const message: ChatMessage = {
    id: value.id,
    role: value.role,
    content: value.content,
    status,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
  };

  if (typeof value.model === 'string') message.model = value.model;
  if (typeof value.reasoning === 'string') message.reasoning = value.reasoning;
  if (typeof value.finishReason === 'string') message.finishReason = value.finishReason;
  if (typeof value.errorKind === 'string') {
    message.errorKind = value.errorKind as ChatMessage['errorKind'];
  }
  if (typeof value.errorMessage === 'string') message.errorMessage = value.errorMessage;
  if (typeof value.errorHint === 'string') message.errorHint = value.errorHint;
  if (value.transport === 'stream' || value.transport === 'complete') {
    message.transport = value.transport;
  }
  if (value.streamFellBack === true) message.streamFellBack = true;

  if (value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage)) {
    const usage = value.usage as Record<string, unknown>;
    const tokenUsage: ChatMessage['usage'] = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
      if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) {
        tokenUsage[key] = usage[key] as number;
      }
    }
    if (Object.keys(tokenUsage).length > 0) message.usage = tokenUsage;
  }

  return message;
}

export function loadConversations(): Conversation[] {
  const value = readJson<unknown[]>(STORAGE_KEYS.conversations, []);
  if (!Array.isArray(value)) return [];

  return value
    .map((raw): Conversation | null => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const conversation = raw as Record<string, unknown>;
      if (typeof conversation.id !== 'string' || conversation.id === '') return null;
      if (!Array.isArray(conversation.messages)) return null;

      const messages = conversation.messages
        .map(sanitizeStoredMessage)
        .filter((message): message is ChatMessage => message !== null)
        .slice(-MAX_MESSAGES_PER_CONVERSATION);

      return {
        id: conversation.id,
        title:
          typeof conversation.title === 'string' && conversation.title.trim()
            ? conversation.title
            : 'Conversation',
        profileId: typeof conversation.profileId === 'string' ? conversation.profileId : null,
        messages,
        createdAt:
          typeof conversation.createdAt === 'string'
            ? conversation.createdAt
            : new Date().toISOString(),
        updatedAt:
          typeof conversation.updatedAt === 'string'
            ? conversation.updatedAt
            : new Date().toISOString(),
      };
    })
    .filter((conversation): conversation is Conversation => conversation !== null)
    .slice(0, MAX_CONVERSATIONS);
}

export function saveConversations(conversations: Conversation[]): void {
  writeJson(STORAGE_KEYS.conversations, conversations.slice(0, MAX_CONVERSATIONS));
}

export function loadPreferences(): UiPreferences {
  const value = readJson<Partial<UiPreferences>>(STORAGE_KEYS.preferences, {});
  const theme =
    typeof value.theme === 'string' && (THEMES as readonly string[]).includes(value.theme)
      ? (value.theme as UiPreferences['theme'])
      : DEFAULT_UI_PREFERENCES.theme;

  return {
    activeProfileId:
      typeof value.activeProfileId === 'string' ? value.activeProfileId : null,
    activeConversationId:
      typeof value.activeConversationId === 'string' ? value.activeConversationId : null,
    theme,
    sendOnEnter:
      typeof value.sendOnEnter === 'boolean'
        ? value.sendOnEnter
        : DEFAULT_UI_PREFERENCES.sendOnEnter,
  };
}

export function savePreferences(preferences: UiPreferences): void {
  writeJson(STORAGE_KEYS.preferences, preferences);
}

/** The drafts of the composer, keyed by conversation id. */
export function loadDrafts(): Record<string, string> {
  const value = readJson<Record<string, unknown>>(STORAGE_KEYS.drafts, {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const drafts: Record<string, string> = {};
  for (const [id, text] of Object.entries(value)) {
    if (typeof text !== 'string') continue;
    if (!text.trim()) continue;
    drafts[id] = text.slice(0, MAX_DRAFT_LENGTH);
    if (Object.keys(drafts).length >= MAX_DRAFTS) break;
  }
  return drafts;
}

export function saveDrafts(drafts: Record<string, string>): void {
  const trimmed: Record<string, string> = {};
  for (const [id, text] of Object.entries(drafts)) {
    if (!text.trim()) continue;
    trimmed[id] = text.slice(0, MAX_DRAFT_LENGTH);
    if (Object.keys(trimmed).length >= MAX_DRAFTS) break;
  }
  writeJson(STORAGE_KEYS.drafts, trimmed);
}

export function removeDraft(conversationId: string): void {
  const drafts = loadDrafts();
  if (!(conversationId in drafts)) return;
  delete drafts[conversationId];
  saveDrafts(drafts);
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
