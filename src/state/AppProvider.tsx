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
import { gateway } from '../lib/gateway';
import {
  clearAllStoredData,
  loadBrowserKeys,
  loadConversations,
  loadPreferences,
  loadProfiles,
  removeDraft,
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

/** Minimum time between two writes of the conversation list. */
const CONVERSATION_SAVE_INTERVAL_MS = 400;

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

  /**
   * Conversations change with every streamed token. Writing the whole list
   * to local storage that often is wasted work, so writes are throttled: the
   * first change is written immediately and at most every
   * `CONVERSATION_SAVE_INTERVAL_MS` after that. The latest state is flushed
   * when the page is hidden or the provider unmounts, so nothing is lost.
   */
  const conversationsRef = useRef(state.conversations);
  const saveTimer = useRef<number | null>(null);
  const lastSave = useRef(0);

  useEffect(() => {
    conversationsRef.current = state.conversations;
    const elapsed = Date.now() - lastSave.current;
    const write = () => {
      saveTimer.current = null;
      lastSave.current = Date.now();
      saveConversations(conversationsRef.current);
    };

    if (elapsed >= CONVERSATION_SAVE_INTERVAL_MS) {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      write();
      return;
    }

    if (saveTimer.current === null) {
      saveTimer.current = window.setTimeout(write, CONVERSATION_SAVE_INTERVAL_MS - elapsed);
    }
  }, [state.conversations]);

  useEffect(() => {
    const flush = () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      saveConversations(conversationsRef.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };

    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, []);

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
    for (const conversation of state.conversations) {
      const usesProfile = (conversation.profileId ?? state.preferences.activeProfileId) === profileId;
      if (!usesProfile) continue;
      const controller = abortControllers.current.get(conversation.id);
      if (controller) {
        controller.abort();
        abortControllers.current.delete(conversation.id);
      }
      const pendingJob = conversation.messages.find((entry) => entry.toolJobId)?.toolJobId;
      if (pendingJob) void gateway.cancelToolJob(pendingJob).catch(() => undefined);
    }
    void gateway.deleteToolProfile(profileId).catch(() => undefined);
    dispatch({ type: 'profiles/delete', id: profileId });
  }, [state.conversations, state.preferences.activeProfileId]);

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
    // Deleting a conversation must stop both an active request and any paused
    // approval, then release its in-memory uploads.
    const controller = abortControllers.current.get(conversationId);
    if (controller) {
      controller.abort();
      abortControllers.current.delete(conversationId);
    }
    const conversation = state.conversations.find((entry) => entry.id === conversationId);
    const pendingJob = conversation?.messages.find((entry) => entry.toolJobId)?.toolJobId;
    if (pendingJob) void gateway.cancelToolJob(pendingJob).catch(() => undefined);
    void gateway.deleteConversationFiles(conversationId).catch(() => undefined);
    removeDraft(conversationId);
    dispatch({ type: 'conversations/delete', id: conversationId });
  }, [state.conversations]);

  const clearConversation = useCallback((conversationId: string) => {
    const conversation = state.conversations.find((entry) => entry.id === conversationId);
    const activeRequest = abortControllers.current.get(conversationId);
    if (activeRequest) {
      activeRequest.abort();
      abortControllers.current.delete(conversationId);
    }
    const pendingJob = conversation?.messages.find((entry) => entry.toolJobId)?.toolJobId;
    if (pendingJob) void gateway.cancelToolJob(pendingJob).catch(() => undefined);
    void gateway.deleteConversationFiles(conversationId).catch(() => undefined);
    dispatch({
      type: 'conversations/patch',
      id: conversationId,
      changes: { title: 'New conversation', messages: [], uploadedFiles: [], updatedAt: new Date().toISOString() },
    });
  }, [state.conversations]);

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
    for (const controller of abortControllers.current.values()) controller.abort();
    abortControllers.current.clear();
    for (const conversation of state.conversations) {
      const pendingJob = conversation.messages.find((message) => message.toolJobId)?.toolJobId;
      if (pendingJob) void gateway.cancelToolJob(pendingJob).catch(() => undefined);
      void gateway.deleteConversationFiles(conversation.id).catch(() => undefined);
      removeDraft(conversation.id);
    }
    clearAllStoredData();
    dispatch({ type: 'state/reset' });
  }, [state.conversations]);

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
