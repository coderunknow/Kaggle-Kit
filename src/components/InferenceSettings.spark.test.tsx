// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_INFERENCE_PARAMS, type ServerCapabilities } from '../../shared/api/requests';
import type { ApiProfile } from '../../shared/domain';
import { AppProvider } from '../state/AppProvider';
import { initialState } from '../state/appState';
import { InferenceSettings } from './InferenceSettings';

function makeProfile(modelId: string, reasoningEffort: 'none' | 'low' | 'medium' | 'high' | null = null): ApiProfile {
  return {
    id: 'profile-spark',
    name: 'Spark profile',
    baseUrl: 'http://127.0.0.1:8000/v1',
    modelId,
    systemPrompt: '',
    timeoutMs: 120_000,
    credentialStorage: 'session',
    defaultParams: { ...DEFAULT_INFERENCE_PARAMS, temperature: 1, topP: 0.95, topK: 0, reasoningEffort },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderSettings(profile: ApiProfile, capabilities: Record<string, ServerCapabilities> = {}) {
  render(
    <AppProvider
      initialAppState={{
        ...initialState,
        profiles: [profile],
        preferences: { ...initialState.preferences, activeProfileId: profile.id },
        capabilities,
      }}
    >
      <InferenceSettings profile={profile} />
    </AppProvider>,
  );
}

describe('InferenceSettings model-specific thinking control', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('offers the three template levels for Spark only when the server confirms template support', () => {
    renderSettings(makeProfile('Spark-X2.6-4B'), {
      'profile-spark': {
        streamingVerified: false,
        reasoningEffortSupported: false,
        templateReasoningEffortSupported: true,
        notes: [],
      },
    });

    expect(screen.getByText(/Thinking level \(Spark-X2.6-4B\)/)).toBeTruthy();
    // The generic control must not compete with the model-specific one.
    expect(screen.queryByLabelText('Effort sent with the request')).toBeNull();

    const select = screen.getByLabelText(/Thinking level sent with the request/) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['', 'none', 'low', 'high']);
    expect(screen.getByText(/reported that its loaded chat template consumes reasoning_effort/)).toBeTruthy();
  });

  it('keeps the control disabled and explains the missing evidence when the server did not report it', () => {
    renderSettings(makeProfile('Spark-X2.6-4B'), {
      'profile-spark': {
        streamingVerified: false,
        reasoningEffortSupported: false,
        templateReasoningEffortSupported: false,
        notes: [],
      },
    });

    const select = screen.getByLabelText(/Thinking level sent with the request/) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(screen.getByText(/has not reported template reasoning-effort support/)).toBeTruthy();
  });

  it('warns about a stored level the Spark template does not accept instead of sending it', () => {
    renderSettings(makeProfile('Spark-X2.6-4B', 'medium'), {
      'profile-spark': {
        streamingVerified: false,
        reasoningEffortSupported: false,
        templateReasoningEffortSupported: true,
        notes: [],
      },
    });

    expect(screen.getByText(/“medium” is not a level of this model and will not be sent/)).toBeTruthy();
    // The request preview has to agree with the builder: the value is omitted.
    expect(document.body.textContent).toContain('reasoning_effort');
  });

  it('does not send reasoning_effort for a valid level in the request preview', async () => {
    const user = userEvent.setup();
    renderSettings(makeProfile('Spark-X2.6-4B'), {
      'profile-spark': {
        streamingVerified: false,
        reasoningEffortSupported: false,
        templateReasoningEffortSupported: true,
        notes: [],
      },
    });

    const select = screen.getByLabelText(/Thinking level sent with the request/);
    await user.selectOptions(select, 'low');

    const preview = screen.getByText(/Not sent with the current settings/).textContent ?? '';
    expect(preview).not.toContain('reasoning_effort');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('keeps the generic reasoning control for models without a template-level control', () => {
    renderSettings(makeProfile('Qwen3.8-27B'), {
      'profile-spark': {
        streamingVerified: false,
        reasoningEffortSupported: true,
        notes: [],
      },
    });

    expect(screen.getByLabelText('Effort sent with the request')).toBeTruthy();
    expect(screen.queryByText(/Thinking level \(Spark-X2.6-4B\)/)).toBeNull();
  });
});
