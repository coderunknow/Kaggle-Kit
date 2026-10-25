import { describe, expect, it, vi } from 'vitest';

import type { ConnectionTestResult } from '../../shared/domain';
import type { ServerCapabilities } from '../../shared/api/requests';
import { DEFAULT_TOOL_LIMITS, DEFAULT_TOOL_PROFILE_SETTINGS } from '../../shared/tools/types';
import type { ProxyService } from '../proxy';
import { createLogger } from '../logger';
import type { SecretStore } from '../secrets';
import { ToolExecutor, type PreparedToolCall, type ToolExecutionContext } from './executor';
import { FileVault } from './files';

function diagnosticsCall(): PreparedToolCall {
  return {
    name: 'diagnostics_check',
    args: {},
    displayName: 'diagnostics_check',
    permission: 'read_only',
    approvalRequired: false,
    summary: 'Run endpoint diagnostics',
  };
}

function context(): ToolExecutionContext {
  return {
    profileId: 'profile-1',
    conversationId: 'conversation-1',
    model: 'mock-model',
    target: { baseUrl: 'https://model.example.invalid/v1' },
    timeoutMs: 5_000,
    limits: { ...DEFAULT_TOOL_LIMITS },
    settings: {
      ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
      enabled: true,
      allowedTools: ['diagnostics_check'],
    },
  };
}

function executorFor(result: ConnectionTestResult): ToolExecutor {
  const proxy = {
    testConnection: vi.fn(async () => result),
  } as unknown as ProxyService;
  const store = {
    list: async () => [] as string[],
    get: async () => undefined,
  } as unknown as SecretStore;
  return new ToolExecutor(
    store,
    proxy,
    new FileVault(),
    createLogger({ sink: () => undefined }),
  );
}

const baseStages: ConnectionTestResult['stages'] = [
  { stage: 'transport', status: 'ok', message: 'answered' },
  { stage: 'auth', status: 'ok', message: 'accepted' },
  { stage: 'models', status: 'ok', message: 'listed' },
  { stage: 'model', status: 'ok', message: 'advertised' },
  { stage: 'inference', status: 'ok', message: 'completed' },
  { stage: 'streaming', status: 'not_run', message: 'not tested' },
];

function capabilities(overrides: Partial<ServerCapabilities> = {}): ServerCapabilities {
  return {
    streamingVerified: false,
    reasoningEffortSupported: false,
    templateReasoningEffortSupported: false,
    notes: [],
    ...overrides,
  };
}

describe('diagnostics_check keeps capabilities and verified behavior apart', () => {
  it('does not call an endpoint "passed" when only the inference was verified', async () => {
    const executor = executorFor({
      ok: true,
      baseUrl: 'https://model.example.invalid/v1',
      modelId: 'mock-model',
      stages: baseStages,
      capabilities: capabilities(),
    });

    const result = await executor.execute(diagnosticsCall(), context());
    const report = JSON.parse(result.content) as {
      fullyVerified: boolean;
      verified: Record<string, boolean>;
      streaming: { status: string; evidence: unknown };
      toolCalling: { status: string };
      notVerifiedByThisCheck: string[];
    };

    expect(result.ok).toBe(true);
    expect(report.fullyVerified).toBe(false);
    expect(report.verified).toMatchObject({
      reachability: true,
      authentication: true,
      modelListing: true,
      inference: true,
      streaming: false,
      toolCalling: false,
      reasoningEffortParameter: false,
    });
    expect(report.streaming).toMatchObject({ status: 'not_verified', evidence: null });
    expect(report.toolCalling.status).toBe('not_verified');
    expect(report.notVerifiedByThisCheck).toEqual(expect.arrayContaining([
      'proxy forwarding of incremental chunks',
      'browser incremental rendering',
      'actual execution of tools',
    ]));
    // The summary is what a model repeats back, so it must not overstate.
    expect(result.summary).toContain('inference verified');
    expect(result.summary).toContain('streaming not verified in this server session');
    expect(result.summary).not.toMatch(/passed/i);
  });

  it('reports the streaming probe evidence verbatim instead of a bare boolean', async () => {
    const executor = executorFor({
      ok: true,
      baseUrl: 'https://model.example.invalid/v1',
      modelId: 'mock-model',
      stages: baseStages,
      capabilities: capabilities({
        streamingVerified: true,
        streamingEvidence: {
          verifiedAt: '2026-10-25T00:00:00.000Z',
          events: 7,
          contentEvents: 6,
          firstContentMs: 120,
          durationMs: 900,
          detail: 'six content events',
        },
        reasoningEffortSupported: true,
        templateReasoningEffortSupported: true,
        toolCalling: {
          status: 'supported_verified',
          model: 'mock-model',
          protocolVerified: true,
          roundTripVerified: true,
          configurationFingerprint: 'abc',
          checkedAt: '2026-10-25T00:00:00.000Z',
          detail: 'two-step round trip',
        },
      }),
    });

    const result = await executor.execute(diagnosticsCall(), context());
    const report = JSON.parse(result.content) as {
      fullyVerified: boolean;
      streaming: { status: string; evidence: { contentEvents: number; firstContentMs: number } };
    };

    expect(report.streaming.status).toBe('verified_earlier_in_this_server_session');
    expect(report.streaming.evidence).toMatchObject({ contentEvents: 6, firstContentMs: 120 });
    expect(result.summary).toContain('6 content event(s), first after 120 ms');
    expect(result.summary).toContain('native tool calling verified');
    expect(result.summary).toContain('not proof of proxy forwarding or browser rendering');
    // Every claim is separately true here, which is the only case where the
    // check may report full verification.
    expect(report.fullyVerified).toBe(true);
  });

  it('reports a failed connection as a failed inference rather than a partial pass', async () => {
    const executor = executorFor({
      ok: false,
      baseUrl: 'https://model.example.invalid/v1',
      stages: [
        { stage: 'transport', status: 'failed', message: 'not reachable' },
        { stage: 'auth', status: 'not_run', message: 'not checked' },
        { stage: 'models', status: 'not_run', message: 'not checked' },
        { stage: 'model', status: 'not_run', message: 'not checked' },
        { stage: 'inference', status: 'not_run', message: 'not checked' },
        { stage: 'streaming', status: 'not_run', message: 'not tested' },
      ],
      errorMessage: 'not reachable',
    });

    const result = await executor.execute(diagnosticsCall(), context());

    expect(result.ok).toBe(false);
    expect(result.summary).toBe('Model endpoint diagnostics failed before inference could be verified');
    expect(result.summary).not.toMatch(/passed/i);
  });
});
