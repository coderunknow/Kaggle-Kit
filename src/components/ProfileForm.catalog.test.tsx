// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_INFERENCE_PARAMS } from '../../shared/api/requests';
import type { ApiProfile } from '../../shared/domain';
import { AppProvider } from '../state/AppProvider';
import { initialState } from '../state/appState';
import { ProfileForm } from './ProfileForm';

const baseProfile: ApiProfile = {
  id: 'profile-1',
  name: 'Catalog profile',
  baseUrl: 'http://127.0.0.1:8000/v1',
  modelId: '',
  systemPrompt: '',
  timeoutMs: 120_000,
  credentialStorage: 'session',
  defaultParams: { ...DEFAULT_INFERENCE_PARAMS },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderForm(profile: ApiProfile, onSaved = vi.fn()) {
  render(
    <AppProvider
      initialAppState={{
        ...initialState,
        profiles: [profile],
        preferences: { ...initialState.preferences, activeProfileId: profile.id },
      }}
    >
      <ProfileForm
        profile={profile}
        isNew={false}
        onSaved={onSaved}
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
      />
    </AppProvider>,
  );
  return { onSaved };
}

describe('ProfileForm model catalog', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('selecting Raon fills the served model ID, shows honest deployment statuses, and saves its sampling only on Save', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderForm(baseProfile);

    await user.selectOptions(screen.getByLabelText('Known models (catalog)'), 'raon-1-mini-preview');

    // The documented served ID is filled into the draft; nothing was saved yet.
    expect(screen.getByLabelText(/^Model ID$/)).toHaveValue('Raon-1-mini-preview');
    expect(screen.getByText(/access-gated/i)).toBeTruthy();
    expect(screen.getByText(/Blocked/)).toBeTruthy();
    expect(screen.getAllByText(/Implemented — not live-verified/).length).toBeGreaterThan(0);
    // No discovery has run, so availability stays unknown — never "available".
    expect(screen.getByText(/No discovery result for this endpoint yet/)).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('kaggle-kit.profiles.v1') ?? '[]')[0]?.modelId ?? '').not.toBe('Raon-1-mini-preview');

    await user.click(screen.getByRole('button', { name: 'Apply recommended sampling' }));
    expect(screen.getByText(/is in the draft\. Save the profile to keep it/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const [saved] = JSON.parse(window.localStorage.getItem('kaggle-kit.profiles.v1') ?? '[]') as ApiProfile[];
    expect(saved?.modelId).toBe('Raon-1-mini-preview');
    expect(saved?.defaultParams.temperature).toBe(1.0);
    expect(saved?.defaultParams.topP).toBe(0.95);
    expect(saved?.defaultParams.topK).toBe(20);
    expect(saved?.defaultParams.minP).toBe(0);
    expect(saved?.defaultParams.repetitionPenalty).toBe(1.0);
    expect(saved?.defaultParams.frequencyPenalty).toBe(0);
    expect(saved?.defaultParams.presencePenalty).toBe(1.5);
    // Untouched by the catalog action.
    expect(saved?.defaultParams.maxTokens).toBe(DEFAULT_INFERENCE_PARAMS.maxTokens);
    expect(saved?.baseUrl).toBe(baseProfile.baseUrl);
  });

  it('selecting Raon never overwrites a hand-typed model ID (e.g. a hosted provider ID)', async () => {
    const user = userEvent.setup();
    renderForm({ ...baseProfile, modelId: 'raon-1-mini-preview' });

    await user.selectOptions(screen.getByLabelText('Known models (catalog)'), 'raon-1-mini-preview');

    expect(screen.getByLabelText(/^Model ID$/)).toHaveValue('raon-1-mini-preview');
    expect(screen.getByText(/kept your model ID/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Use Raon-1-mini-preview' }));
    expect(screen.getByLabelText(/^Model ID$/)).toHaveValue('Raon-1-mini-preview');
  });

  it('selecting Qwen never overwrites a hand-typed model ID', async () => {
    const user = userEvent.setup();
    renderForm({ ...baseProfile, modelId: 'my-manual-model' });

    await user.selectOptions(screen.getByLabelText('Known models (catalog)'), 'Qwen3.8-27b');

    expect(screen.getByLabelText(/^Model ID$/)).toHaveValue('my-manual-model');
    expect(screen.getByText(/Pre-existing — not re-verified live/)).toBeTruthy();
  });

  it('reports a catalog model that discovery did not advertise instead of claiming a switch', async () => {
    const user = userEvent.setup();
    render(
      <AppProvider
        initialAppState={{
          ...initialState,
          profiles: [baseProfile],
          preferences: { ...initialState.preferences, activeProfileId: baseProfile.id },
          discoveredModels: { [baseProfile.id]: ['Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf'] },
        }}
      >
        <ProfileForm
          profile={baseProfile}
          isNew={false}
          onSaved={vi.fn()}
          onCancel={vi.fn()}
          onDeleted={vi.fn()}
        />
      </AppProvider>,
    );

    await user.selectOptions(screen.getByLabelText('Known models (catalog)'), 'raon-1-mini-preview');
    expect(screen.getByText(/is not in this endpoint's \/v1\/models list/)).toBeTruthy();
    expect(screen.getByText(/does not switch a remote server/)).toBeTruthy();
  });

  it('selecting Spark fills only an empty model ID, shows honest statuses and applies official sampling on Save', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderForm(baseProfile);

    await user.selectOptions(screen.getByLabelText('Known models (catalog)'), 'spark-x2.6-4b');

    expect(screen.getByLabelText(/^Model ID$/)).toHaveValue('Spark-X2.6-4B');
    expect(screen.getAllByText(/Apache-2.0/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Implemented — not live-verified/)).toBeTruthy();
    expect(screen.getByText(/Blocked/)).toBeTruthy();
    expect(screen.getByText(/No discovery result for this endpoint yet/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Apply recommended sampling' }));
    expect(screen.getByText(/is in the draft\. Save the profile to keep it/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const [saved] = JSON.parse(window.localStorage.getItem('kaggle-kit.profiles.v1') ?? '[]') as ApiProfile[];
    expect(saved?.modelId).toBe('Spark-X2.6-4B');
    expect(saved?.defaultParams.temperature).toBe(1.0);
    expect(saved?.defaultParams.topP).toBe(0.95);
    expect(saved?.defaultParams.topK).toBe(0);
    expect(saved?.defaultParams.frequencyPenalty).toBeUndefined();
    expect(saved?.defaultParams.presencePenalty).toBeUndefined();
    // Applying sampling never changes thinking, output length or transport.
    expect(saved?.defaultParams.reasoningEffort).toBeNull();
    expect(saved?.defaultParams.maxTokens).toBe(DEFAULT_INFERENCE_PARAMS.maxTokens);
    expect(saved?.defaultParams.stream).toBe(false);
  });

  it('selecting Spark never overwrites a hand-typed model ID', async () => {
    const user = userEvent.setup();
    renderForm({ ...baseProfile, modelId: 'spark-local-ft' });

    await user.selectOptions(screen.getByLabelText('Known models (catalog)'), 'spark-x2.6-4b');

    expect(screen.getByLabelText(/^Model ID$/)).toHaveValue('spark-local-ft');
    expect(screen.getByText(/kept your model ID/i)).toBeTruthy();
    // The explicit override is available but only changes the draft.
    await user.click(screen.getByRole('button', { name: 'Use Spark-X2.6-4B' }));
    expect(screen.getByLabelText(/^Model ID$/)).toHaveValue('Spark-X2.6-4B');
  });
});
