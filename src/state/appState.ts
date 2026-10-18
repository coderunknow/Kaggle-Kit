/**
 * Application state.
 *
 * A single reducer owns profiles, conversations, preferences and the
 * credential stores. Keeping it in one place makes the persistence rules
 * explicit and keeps the components free of state plumbing.
 */

import type { ServerCapabilities } from '../../shared/api/requests';
import type { ApiProfile, ConnectionTestResult, Conversation, UiPreferences } from '../../shared/domain';

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
  | { type: 'preferences/set'; preferences: Partial<UiPreferences> }
  | { type: 'keys/setSession'; profileId: string; apiKey: string }
  | { type: 'keys/clearSession'; profileId: string }
  | { type: 'keys/setBrowser'; profileId: string; apiKey: string }
  | { type: 'keys/clearBrowser'; profileId: string }
  | { type: 'keys/clearAll' }
  | { type: 'capabilities/set'; profileId: string; capabilities: ServerCapabilities }
  | { type: 'connectionTest/set'; profileId: string; result: ConnectionTestResult | undefined }
  | { type: 'models/set'; profileId: string; models: string[] }
  | { type: 'state/reset' };

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'profiles/upsert': {
      const exists = state.profiles.some((profile) => profile.id === action.profile.id);
      const profiles = exists
        ? state.profiles.map((profile) =>
            profile.id === action.profile.id ? action.profile : profile,
          )
        : [...state.profiles, action.profile];
      return { ...state, profiles };
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

    case 'preferences/set':
      return { ...state, preferences: { ...state.preferences, ...action.preferences } };

    case 'keys/setSession':
      return { ...state, sessionKeys: { ...state.sessionKeys, [action.profileId]: action.apiKey } };

    case 'keys/clearSession': {
      const { [action.profileId]: _removed, ...rest } = state.sessionKeys;
      return { ...state, sessionKeys: rest };
    }

    case 'keys/setBrowser':
      return { ...state, browserKeys: { ...state.browserKeys, [action.profileId]: action.apiKey } };

    case 'keys/clearBrowser': {
      const { [action.profileId]: _removed, ...rest } = state.browserKeys;
      return { ...state, browserKeys: rest };
    }

    case 'keys/clearAll':
      return { ...state, sessionKeys: {}, browserKeys: {} };

    case 'capabilities/set':
      return {
        ...state,
        capabilities: { ...state.capabilities, [action.profileId]: action.capabilities },
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
