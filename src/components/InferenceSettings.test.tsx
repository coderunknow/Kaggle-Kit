// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_INFERENCE_PARAMS } from '../../shared/api/requests';
import type { ApiProfile } from '../../shared/domain';
import { DEFAULT_TOOL_PROFILE_SETTINGS } from '../../shared/tools/types';
import { STORAGE_KEYS } from '../lib/storage';
import { AppProvider } from '../state/AppProvider';
import { InferenceSettings } from './InferenceSettings';

function profile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'profile-stream',
    name: 'Saved streaming preference',
    baseUrl: 'https://model.example.invalid/v1',
    modelId: 'mock-model',
    systemPrompt: '',
    timeoutMs: 30_000,
    credentialStorage: 'session',
    defaultParams: { ...DEFAULT_INFERENCE_PARAMS, stream: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tools: structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
    ...overrides,
  };
}

function seed(profiles: ApiProfile[]): void {
  window.localStorage.clear();
  window.localStorage.setItem(STORAGE_KEYS.profiles, JSON.stringify(profiles));
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('streaming preference in the inference settings', () => {
  it('keeps a saved streaming preference when another parameter is saved without verification', async () => {
    const saved = profile();
    seed([saved]);
    const user = userEvent.setup();
    render(
      <AppProvider>
        <InferenceSettings profile={saved} />
      </AppProvider>,
    );

    const streamSwitch = screen.getByRole('checkbox', { name: /stream the answer/i });
    // The preference is shown, but it cannot be used until this session has
    // verified streaming, so the control explains that instead of hiding it.
    expect(streamSwitch).toBeChecked();
    expect(streamSwitch).toBeDisabled();
    expect(screen.getByText(/saved as enabled, but disabled until streaming is verified/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save parameters/i }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEYS.profiles) ?? '[]') as ApiProfile[];
      expect(stored[0]?.defaultParams.stream).toBe(true);
    });
  });

  it('does not claim streaming is active when this session has not verified it', () => {
    const saved = profile();
    seed([saved]);
    render(
      <AppProvider>
        <InferenceSettings profile={saved} />
      </AppProvider>,
    );

    // The request preview reflects what would be sent now, not the stored
    // preference, so it must omit `stream`.
    expect(screen.queryByText(/stream: true/i)).toBeNull();
    expect(screen.queryByText(/^streaming verified$/i)).toBeNull();
  });
});
