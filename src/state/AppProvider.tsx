/**
 * Application provider.
 *
 * Owns the reducer state, persists the non-sensitive parts to browser storage
 * and exposes the actions the UI needs. Credentials are handled separately
 * from ordinary settings:
 *
 *  - `session` mode keys live in memory only and disappear on reload,
 *  - `server` mode keys live in the backend secret store,
 *  - `browser` mode keys are an explicit opt-in and are stored as plain text.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from 'react';

import type { ApiProfile, Conversation } from '../../shared/domain';
import { createId } from '../lib/id';
import {
  clearAllStoredData,
  loadBrowserKeys,
  loadConversations,
  loadPreferences,
  loadProfiles,
  saveBrowserKeys,
  saveConversations,
  savePreferences,
  saveProfiles,
} from '../lib/storage';
import { appReducer, initialState, type AppAction, type AppState } from './appState';

export interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  activeProfile: ApiProfile | undefined;
  activeConversation: Conversation | undefined;
  saveProfile: (profile: ApiProfile) => void;
  deleteProfile: (profileId: string) => void;
  selectProfile: (profileId: string | null) => void;
  setSessionKey: (profileId: string, apiKey: string) => void;
  setBrowserKey: (profileId: string, apiKey: string) => void;
  clearCredentials: () => void;
  clearBrowserKey: (profileId: string) => void;
  newConversation: (profileId?: string | null) => string;
  renameConversation: (conversationId: string, title: string) => void;
  deleteConversation: (conversationId: string) => void;
  clearConversation: (conversationId: string) => void;
  selectConversation: (conversationId: string | null) => void;
  updateConversation: (conversation: Conversation) => void;
  registerRequest: (conversationId: string, controller: AbortController) => void;
  finishRequest: (conversationId: string) => void;
  cancelRequest: (conversationId: string) => void;
  resetEverything: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function initState(): AppState {
  return {
    ...initialState,
    profiles: loadProfiles(),
    conversations: loadConversations(),
    preferences: loadPreferences(),
    browserKeys: loadBrowserKeys(),
  };
}

export interface AppProviderProps {
  children: ReactNode;
  /** Test seam: allows injecting a pre-built state. */
  initialAppState?: AppState;
}

export function AppProvider({ children, initialAppState }: AppProviderProps) {
  const [state, dispatch] = useReducer(appReducer, initialAppState, (provided) =>
    provided ? provided : initState(),
  );

  const abortControllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    saveProfiles(state.profiles);
  }, [state.profiles]);

  useEffect(() => {
    saveConversations(state.conversations);
  }, [state.conversations]);

  useEffect(() => {
    savePreferences(state.preferences);
  }, [state.preferences]);

  useEffect(() => {
    saveBrowserKeys(state.browserKeys);
  }, [state.browserKeys]);

  const saveProfile = useCallback((profile: ApiProfile) => {
    dispatch({ type: 'profiles/upsert', profile });
  }, []);

  const deleteProfile = useCallback((profileId: string) => {
    dispatch({ type: 'profiles/delete', id: profileId });
  }, []);

  const selectProfile = useCallback((profileId: string | null) => {
    dispatch({ type: 'profiles/select', id: profileId });
  }, []);

  const setSessionKey = useCallback((profileId: string, apiKey: string) => {
    dispatch({ type: 'keys/setSession', profileId, apiKey });
  }, []);

  const setBrowserKey = useCallback((profileId: string, apiKey: string) => {
    dispatch({ type: 'keys/setBrowser', profileId, apiKey });
  }, []);

  const clearBrowserKey = useCallback((profileId: string) => {
    dispatch({ type: 'keys/clearBrowser', profileId });
  }, []);

  const clearCredentials = useCallback(() => {
    dispatch({ type: 'keys/clearAll' });
  }, []);

  const newConversation = useCallback(
    (profileId?: string | null): string => {
      const id = createId('conv');
      const now = new Date().toISOString();
      const conversation: Conversation = {
        id,
        title: 'New conversation',
        profileId: profileId ?? state.preferences.activeProfileId,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      dispatch({ type: 'conversations/upsert', conversation });
      dispatch({ type: 'conversations/select', id });
      return id;
    },
    [state.preferences.activeProfileId],
  );

  const renameConversation = useCallback((conversationId: string, title: string) => {
    dispatch({
      type: 'conversations/patch',
      id: conversationId,
      changes: { title, updatedAt: new Date().toISOString() },
    });
  }, []);

  const deleteConversation = useCallback((conversationId: string) => {
    dispatch({ type: 'conversations/delete', id: conversationId });
  }, []);

  const clearConversation = useCallback((conversationId: string) => {
    dispatch({
      type: 'conversations/patch',
      id: conversationId,
      changes: { title: 'New conversation', messages: [], updatedAt: new Date().toISOString() },
    });
  }, []);

  const selectConversation = useCallback((conversationId: string | null) => {
    dispatch({ type: 'conversations/select', id: conversationId });
  }, []);

  const updateConversation = useCallback((conversation: Conversation) => {
    dispatch({ type: 'conversations/upsert', conversation });
  }, []);

  const registerRequest = useCallback((conversationId: string, controller: AbortController) => {
    abortControllers.current.set(conversationId, controller);
  }, []);

  const finishRequest = useCallback((conversationId: string) => {
    abortControllers.current.delete(conversationId);
  }, []);

  const cancelRequest = useCallback((conversationId: string) => {
    const controller = abortControllers.current.get(conversationId);
    if (controller) {
      controller.abort();
      abortControllers.current.delete(conversationId);
    }
  }, []);

  const resetEverything = useCallback(() => {
    clearAllStoredData();
    dispatch({ type: 'state/reset' });
  }, []);

  const activeProfile = useMemo(
    () => state.profiles.find((profile) => profile.id === state.preferences.activeProfileId),
    [state.profiles, state.preferences.activeProfileId],
  );

  const activeConversation = useMemo(
    () =>
      state.conversations.find(
        (conversation) => conversation.id === state.preferences.activeConversationId,
      ),
    [state.conversations, state.preferences.activeConversationId],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      dispatch,
      activeProfile,
      activeConversation,
      saveProfile,
      deleteProfile,
      selectProfile,
      setSessionKey,
      setBrowserKey,
      clearBrowserKey,
      clearCredentials,
      newConversation,
      renameConversation,
      deleteConversation,
      clearConversation,
      selectConversation,
      updateConversation,
      registerRequest,
      finishRequest,
      cancelRequest,
      resetEverything,
    }),
    [
      state,
      activeProfile,
      activeConversation,
      saveProfile,
      deleteProfile,
      selectProfile,
      setSessionKey,
      setBrowserKey,
      clearBrowserKey,
      clearCredentials,
      newConversation,
      renameConversation,
      deleteConversation,
      clearConversation,
      selectConversation,
      updateConversation,
      registerRequest,
      finishRequest,
      cancelRequest,
      resetEverything,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used inside an AppProvider.');
  }
  return context;
}
