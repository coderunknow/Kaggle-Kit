// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { gateway } from '../lib/gateway';
import { AppProvider, useApp } from './AppProvider';
import { initialState } from './appState';

function RequestHarness({ controller }: { controller: AbortController }) {
  const { registerRequest, clearConversation } = useApp();
  useEffect(() => {
    registerRequest('conversation-1', controller);
  }, [controller, registerRequest]);
  return <button onClick={() => clearConversation('conversation-1')}>Clear conversation</button>;
}

function ResetHarness() {
  const { resetEverything } = useApp();
  return <button onClick={resetEverything}>Erase browser data</button>;
}

function DeleteProfileHarness() {
  const { deleteProfile } = useApp();
  return <button onClick={() => deleteProfile('profile-1')}>Delete profile</button>;
}

const testProfile = {
  id: 'profile-1',
  name: 'Local model',
  baseUrl: 'https://model.example/v1',
  modelId: 'mock-model',
  systemPrompt: '',
  timeoutMs: 5_000,
  credentialStorage: 'session' as const,
  defaultParams: { maxTokens: 128, temperature: 0, topP: 1, stream: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('AppProvider request lifecycle', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('aborts an active request when the conversation is cleared', async () => {
    const controller = new AbortController();
    const user = userEvent.setup();
    render(
      <AppProvider initialAppState={{
        ...initialState,
        conversations: [{
          id: 'conversation-1', title: 'Active', profileId: null, messages: [],
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      }}>
        <RequestHarness controller={controller} />
      </AppProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Clear conversation' }));
    expect(controller.signal.aborted).toBe(true);
  });

  it('requests deletion of the matching server-side tool profile when a profile is deleted', async () => {
    const deleteToolProfile = vi.spyOn(gateway, 'deleteToolProfile').mockResolvedValue();
    const user = userEvent.setup();
    render(
      <AppProvider initialAppState={{ ...initialState, profiles: [testProfile] }}>
        <DeleteProfileHarness />
      </AppProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Delete profile' }));
    await waitFor(() => expect(deleteToolProfile).toHaveBeenCalledWith('profile-1'));
    expect(deleteToolProfile).toHaveBeenCalledTimes(1);
  });

  it('cancels paused tools and removes conversation files when browser data is erased', async () => {
    const cancelJob = vi.spyOn(gateway, 'cancelToolJob').mockResolvedValue(true);
    const deleteFiles = vi.spyOn(gateway, 'deleteConversationFiles').mockResolvedValue();
    const user = userEvent.setup();
    render(
      <AppProvider initialAppState={{
        ...initialState,
        conversations: [{
          id: 'conversation-1', title: 'Pending', profileId: null,
          messages: [{ id: 'assistant-1', role: 'assistant', content: '', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', toolJobId: 'job-1' }],
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      }}>
        <ResetHarness />
      </AppProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Erase browser data' }));
    await waitFor(() => {
      expect(cancelJob).toHaveBeenCalledWith('job-1');
      expect(deleteFiles).toHaveBeenCalledWith('conversation-1');
    });
  });
});
