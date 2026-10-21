/**
 * Application state.
 *
 * A single reducer owns profiles, conversations, preferences and the
 * credential stores. Keeping it in one place makes the persistence rules
 * explicit and keeps the components free of state plumbing.
 */

import type { ServerCapabilities } from '../../shared/api/requests';
import { effectiveProfileTarget } from '../../shared/connection';
import type {
  ApiProfile,
  ChatMessage,
  ConnectionTestResult,
  Conversation,
  UiPreferences,
} from '../../shared/domain';

export interface AppState {
  profiles: ApiProfile[];
  conversations: Conversation[];
  preferences: UiPreferences;
  /** API keys held in memory for the current page load only. */
  sessionKeys: Record<string, string>;
  /** API keys stored in browser storage (explicit opt-in only). */
  browserKeys: Record<string, string>;
  /** Detected capabilities per profile id. */
  capabilities: Record<string, ServerCapabilities>;
  /** Result of the last connection test per profile id. */
  connectionTests: Record<string, ConnectionTestResult | undefined>;
  /** Model IDs discovered per profile id. */
  discoveredModels: Record<string, string[]>;
}

export const initialState: AppState = {
  profiles: [],
  conversations: [],
  preferences: {
    activeProfileId: null,
    activeConversationId: null,
    theme: 'system',
    sendOnEnter: true,
  },
  sessionKeys: {},
  browserKeys: {},
  capabilities: {},
  connectionTests: {},
  discoveredModels: {},
};

export type AppAction =
  | { type: 'profiles/upsert'; profile: ApiProfile }
  | { type: 'profiles/delete'; id: string }
  | { type: 'profiles/select'; id: string | null }
  | { type: 'conversations/upsert'; conversation: Conversation }
  | { type: 'conversations/patch'; id: string; changes: Partial<Omit<Conversation, 'id'>> }
  | { type: 'conversations/delete'; id: string }
  | { type: 'conversations/select'; id: string | null }
  | { type: 'messages/patch'; conversationId: string; messageId: string; changes: Partial<ChatMessage> }
  | { type: 'messages/append'; conversationId: string; messageId: string; content?: string; reasoning?: string }
  | { type: 'preferences/set'; preferences: Partial<UiPreferences> }
  | { type: 'keys/setSession'; profileId: string; apiKey: string }
  | { type: 'keys/clearSession'; profileId: string }
  | { type: 'keys/setBrowser'; profileId: string; apiKey: string }
  | { type: 'keys/clearBrowser'; profileId: string }
  | { type: 'keys/clearAll' }
  | { type: 'capabilities/set'; profileId: string; capabilities: ServerCapabilities }
  | { type: 'capabilities/clear'; profileId: string }
  | { type: 'connectionTest/set'; profileId: string; result: ConnectionTestResult | undefined }
  | { type: 'connection/invalidate'; profileId: string; models?: boolean }
  | { type: 'models/set'; profileId: string; models: string[] }
  | { type: 'state/reset' };

/**
 * Everything the connection test depends on. A change here invalidates the
 * stored result; a change of the name, the system prompt or the request
 * parameters does not, because none of them is part of the test.
 */
function connectionIdentity(profile: ApiProfile): string {
  const target = effectiveProfileTarget(profile);
  return [
    target.baseUrl,
    profile.modelId.trim(),
    String(profile.timeoutMs),
    profile.credentialStorage,
    profile.secretRef ?? '',
  ].join('\u0000');
}

/** The endpoint part of the identity: discovery results depend on it too. */
function endpointIdentity(profile: ApiProfile): string {
  const target = effectiveProfileTarget(profile);
  return [
    target.baseUrl,
    profile.credentialStorage,
    profile.secretRef ?? '',
  ].join('\u0000');
}

function dropProfileEntry<T>(
  record: Record<string, T>,
  profileId: string,
): Record<string, T> {
  if (!(profileId in record)) return record;
  const { [profileId]: _removed, ...rest } = record;
  return rest;
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'profiles/upsert': {
      const previous = state.profiles.find((profile) => profile.id === action.profile.id);
      const exists = previous !== undefined;
      const profiles = exists
        ? state.profiles.map((profile) =>
            profile.id === action.profile.id ? action.profile : profile,
          )
        : [...state.profiles, action.profile];

      if (!previous || connectionIdentity(previous) === connectionIdentity(action.profile)) {
        return { ...state, profiles };
      }

      // The edited profile is no longer the configuration that was tested.
      // Keeping the old result would show a green state for a URL, model or
      // timeout that was never tested.
      const endpointChanged = endpointIdentity(previous) !== endpointIdentity(action.profile);
      return {
        ...state,
        profiles,
        connectionTests: dropProfileEntry(state.connectionTests, action.profile.id),
        capabilities: dropProfileEntry(state.capabilities, action.profile.id),
        ...(endpointChanged
          ? { discoveredModels: dropProfileEntry(state.discoveredModels, action.profile.id) }
          : {}),
      };
    }

    case 'profiles/delete': {
      const profiles = state.profiles.filter((profile) => profile.id !== action.id);
      const { [action.id]: _removedSession, ...sessionKeys } = state.sessionKeys;
      const { [action.id]: _removedBrowser, ...browserKeys } = state.browserKeys;
      const { [action.id]: _removedCaps, ...capabilities } = state.capabilities;
      const { [action.id]: _removedModels, ...discoveredModels } = state.discoveredModels;
      const { [action.id]: _removedTest, ...connectionTests } = state.connectionTests;

      return {
        ...state,
        profiles,
        sessionKeys,
        browserKeys,
        capabilities,
        discoveredModels,
        connectionTests,
        preferences: {
          ...state.preferences,
          activeProfileId: state.preferences.activeProfileId === action.id ? null : state.preferences.activeProfileId,
        },
        conversations: state.conversations.map((conversation) =>
          conversation.profileId === action.id ? { ...conversation, profileId: null } : conversation,
        ),
      };
    }

    case 'profiles/select':
      return { ...state, preferences: { ...state.preferences, activeProfileId: action.id } };

    case 'conversations/upsert': {
      const exists = state.conversations.some(
        (conversation) => conversation.id === action.conversation.id,
      );
      const conversations = exists
        ? state.conversations.map((conversation) =>
            conversation.id === action.conversation.id ? action.conversation : conversation,
          )
        : [action.conversation, ...state.conversations];
      return { ...state, conversations };
    }

    case 'conversations/patch': {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.id
            ? { ...conversation, ...action.changes, id: conversation.id }
            : conversation,
        ),
      };
    }

    case 'conversations/delete': {
      const conversations = state.conversations.filter(
        (conversation) => conversation.id !== action.id,
      );
      return {
        ...state,
        conversations,
        preferences: {
          ...state.preferences,
          activeConversationId:
            state.preferences.activeConversationId === action.id
              ? null
              : state.preferences.activeConversationId,
        },
      };
    }

    case 'conversations/select':
      return { ...state, preferences: { ...state.preferences, activeConversationId: action.id } };

    case 'messages/patch': {
      let changed = false;
      const conversations = state.conversations.map((conversation) => {
        if (conversation.id !== action.conversationId) return conversation;
        let patched = false;
        const messages = conversation.messages.map((message) => {
          if (message.id !== action.messageId) return message;
          patched = true;
          return { ...message, ...action.changes };
        });
        // Only the conversation that really contains the message is rewritten;
        // a patch must not reorder unrelated conversations by updating their
        // timestamp.
        if (!patched) return conversation;
        changed = true;
        return { ...conversation, messages, updatedAt: new Date().toISOString() };
      });
      // A conversation that was deleted while the request was running is not
      // created again by a late answer.
      return changed ? { ...state, conversations } : state;
    }

    case 'messages/append': {
      let changed = false;
      const conversations = state.conversations.map((conversation) => {
        if (conversation.id !== action.conversationId) return conversation;
        let patched = false;
        const messages = conversation.messages.map((message) => {
          if (message.id !== action.messageId) return message;
          patched = true;
          return {
            ...message,
            content: message.content + (action.content ?? ''),
            reasoning:
              action.reasoning === undefined
                ? message.reasoning
                : `${message.reasoning ?? ''}${action.reasoning}`,
          };
        });
        if (!patched) return conversation;
        changed = true;
        return { ...conversation, messages, updatedAt: new Date().toISOString() };
      });
      return changed ? { ...state, conversations } : state;
    }

    case 'preferences/set':
      return { ...state, preferences: { ...state.preferences, ...action.preferences } };

    case 'keys/setSession': {
      const unchanged = state.sessionKeys[action.profileId] === action.apiKey;
      return {
        ...state,
        sessionKeys: { ...state.sessionKeys, [action.profileId]: action.apiKey },
        ...(unchanged
          ? {}
          : {
              connectionTests: dropProfileEntry(state.connectionTests, action.profileId),
              capabilities: dropProfileEntry(state.capabilities, action.profileId),
            }),
      };
    }

    case 'keys/clearSession': {
      const { [action.profileId]: _removed, ...rest } = state.sessionKeys;
      return {
        ...state,
        sessionKeys: rest,
        connectionTests: dropProfileEntry(state.connectionTests, action.profileId),
        capabilities: dropProfileEntry(state.capabilities, action.profileId),
      };
    }

    case 'keys/setBrowser': {
      const unchanged = state.browserKeys[action.profileId] === action.apiKey;
      return {
        ...state,
        browserKeys: { ...state.browserKeys, [action.profileId]: action.apiKey },
        ...(unchanged
          ? {}
          : {
              connectionTests: dropProfileEntry(state.connectionTests, action.profileId),
              capabilities: dropProfileEntry(state.capabilities, action.profileId),
            }),
      };
    }

    case 'keys/clearBrowser': {
      const { [action.profileId]: _removed, ...rest } = state.browserKeys;
      return {
        ...state,
        browserKeys: rest,
        connectionTests: dropProfileEntry(state.connectionTests, action.profileId),
        capabilities: dropProfileEntry(state.capabilities, action.profileId),
      };
    }

    case 'keys/clearAll':
      return { ...state, sessionKeys: {}, browserKeys: {}, connectionTests: {}, capabilities: {} };

    case 'capabilities/set': {
      // A streaming/props re-detection carries no tool-calling probe result of
      // its own; overwriting the whole record would silently drop a separately
      // verified tool capability. The existing toolCalling is preserved only
      // when the incoming payload has none — a newer explicit probe result
      // always wins, and nothing is inferred here.
      const existing = state.capabilities[action.profileId];
      const merged: ServerCapabilities = {
        ...action.capabilities,
        ...(action.capabilities.toolCalling === undefined && existing?.toolCalling
          ? { toolCalling: existing.toolCalling }
          : {}),
      };
      return {
        ...state,
        capabilities: { ...state.capabilities, [action.profileId]: merged },
      };
    }

    case 'capabilities/clear':
      return {
        ...state,
        capabilities: dropProfileEntry(state.capabilities, action.profileId),
      };

    case 'connection/invalidate':
      return {
        ...state,
        connectionTests: dropProfileEntry(state.connectionTests, action.profileId),
        capabilities: dropProfileEntry(state.capabilities, action.profileId),
        ...(action.models
          ? { discoveredModels: dropProfileEntry(state.discoveredModels, action.profileId) }
          : {}),
      };

    case 'connectionTest/set':
      return {
        ...state,
        connectionTests: { ...state.connectionTests, [action.profileId]: action.result },
      };

    case 'models/set':
      return {
        ...state,
        discoveredModels: { ...state.discoveredModels, [action.profileId]: action.models },
      };

    case 'state/reset':
      return { ...initialState };

    default:
      return state;
  }
}
