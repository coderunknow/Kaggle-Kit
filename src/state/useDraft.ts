/**
 * Composer draft of one conversation.
 *
 * The text is written to local storage on every change and restored when the
 * conversation is opened again. Drafts of other conversations are kept, so
 * switching back and forth does not lose text.
 */

import { useCallback, useState } from 'react';

import { loadDrafts, saveDrafts } from '../lib/storage';

export function useDraft(conversationId: string | undefined): [string, (value: string) => void] {
  // The chat view is keyed by the conversation id, so the initial value is
  // always read for the conversation that is displayed.
  const [draft, setDraft] = useState(() =>
    conversationId ? (loadDrafts()[conversationId] ?? '') : '',
  );

  const update = useCallback(
    (value: string) => {
      setDraft(value);
      const drafts = loadDrafts();
      if (!conversationId) return;
      if (value.trim()) drafts[conversationId] = value;
      else delete drafts[conversationId];
      saveDrafts(drafts);
    },
    [conversationId],
  );

  return [draft, update];
}
