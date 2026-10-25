import { describe, expect, it, vi } from 'vitest';

import type { ConnectionTestResult } from '../../shared/domain';
import type { ServerCapabilities } from '../../shared/api/requests';
import { DEFAULT_TOOL_LIMITS, DEFAULT_TOOL_PROFILE_SETTINGS } from '../../shared/tools/types';
import type { ProxyService } from '../proxy';
import { createLogger } from '../logger';
import type { SecretStore } from '../secrets';
import { ToolExecutor, type PreparedToolCall, type ToolExecutionContext } from './executor';
import { FileVault } from './files';
import { untrustedOutputBudget, wrapUntrustedOutput } from './untrusted';

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

function filesExecutor(vault: FileVault): ToolExecutor {
  const proxy = {} as unknown as ProxyService;
  const store = {
    list: async () => [] as string[],
    get: async () => undefined,
  } as unknown as SecretStore;
  return new ToolExecutor(store, proxy, vault, createLogger({ sink: () => undefined }));
}

function filesContext(maxOutputBytes: number): ToolExecutionContext {
  return {
    ...context(),
    limits: { ...DEFAULT_TOOL_LIMITS, maxOutputBytes },
    settings: {
      ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
      enabled: true,
      allowedTools: ['files_analyze'],
    },
  };
}

function analyzeCall(fileId: string, question: string): PreparedToolCall {
  return {
    name: 'files_analyze',
    args: { file_id: fileId, question },
    displayName: 'files_analyze',
    permission: 'read_only',
    approvalRequired: false,
    summary: 'Analyze the uploaded file',
  };
}

/** The analysis JSON follows the one-line heading. */
function analysisPayload(content: string): Record<string, unknown> {
  const start = content.indexOf('{');
  return JSON.parse(content.slice(start)) as Record<string, unknown>;
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
      credentialUsed: true,
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
    expect(result.summary).toContain('authentication verified with an API key');
    expect(result.summary).toContain('streaming not verified in this server session');
    expect(result.summary).not.toMatch(/passed/i);
  });

  it('reports the streaming probe evidence verbatim instead of a bare boolean', async () => {
    const executor = executorFor({
      ok: true,
      baseUrl: 'https://model.example.invalid/v1',
      modelId: 'mock-model',
      stages: baseStages,
      credentialUsed: true,
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

describe('files_analyze output stays parseable inside the tool output budget', () => {
  const wideCsv = () => {
    const rows = Array.from(
      { length: 300 },
      (_, index) => `dept${index},${1000 + index},owner${index},${'note '.repeat(45)}`,
    );
    return ['department,amount,owner,note', ...rows].join('\n');
  };

  async function wideFile(vault: FileVault): Promise<string> {
    const file = await vault.upload({
      name: 'wide.csv',
      mediaType: 'text/csv',
      bytes: new TextEncoder().encode(wideCsv()),
      conversationId: 'conversation-1',
    });
    return file.id;
  }

  it('keeps valid JSON and the matches at the default 24 kB boundary', async () => {
    const vault = new FileVault();
    const fileId = await wideFile(vault);
    const executor = filesExecutor(vault);

    const result = await executor.execute(analyzeCall(fileId, 'dept299'), filesContext(DEFAULT_TOOL_LIMITS.maxOutputBytes));

    // The result has to fit the budget that includes the untrusted-data
    // prefix, otherwise the central truncation cuts through the JSON.
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
      untrustedOutputBudget(DEFAULT_TOOL_LIMITS.maxOutputBytes),
    );
    expect(Buffer.byteLength(wrapUntrustedOutput(result.content, DEFAULT_TOOL_LIMITS.maxOutputBytes), 'utf8'))
      .toBeLessThanOrEqual(DEFAULT_TOOL_LIMITS.maxOutputBytes);

    const payload = analysisPayload(result.content);
    expect(payload.structure).toMatchObject({ lines: 301, truncated: false });
    expect(payload.matches).toEqual([{ line: 301, text: expect.stringContaining('dept299') }]);
    expect(payload.matchesTruncated).toBeUndefined();
    expect(payload.excerptTruncated).toBe(true);
    expect(typeof payload.excerpt).toBe('string');
    expect(result.summary).toMatch(/excerpt shortened/i);
  });

  it('keeps the matches for a smaller but still realistic budget', async () => {
    const vault = new FileVault();
    const fileId = await wideFile(vault);
    const executor = filesExecutor(vault);

    const result = await executor.execute(analyzeCall(fileId, 'dept299'), filesContext(1_200));

    const payload = analysisPayload(result.content);
    expect(payload.matches).toHaveLength(1);
    expect(payload.excerptTruncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(untrustedOutputBudget(1_200));
    expect(Buffer.byteLength((payload.excerpt as string), 'utf8')).toBeLessThan(600);
  });

  it('drops the matches explicitly when even they do not fit', async () => {
    const vault = new FileVault();
    const fileId = await wideFile(vault);
    const executor = filesExecutor(vault);

    const result = await executor.execute(analyzeCall(fileId, 'dept299'), filesContext(600));

    const payload = analysisPayload(result.content);
    expect(payload.matches).toEqual([]);
    expect(payload.matchesTruncated).toBe(true);
    expect(payload.excerptTruncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(untrustedOutputBudget(600));
    expect(result.summary).toMatch(/matches and excerpt limited/i);
  });

  it('returns a small valid document when the budget cannot hold the fixed part', async () => {
    const vault = new FileVault();
    const fileId = await wideFile(vault);
    const executor = filesExecutor(vault);

    const result = await executor.execute(analyzeCall(fileId, 'dept299'), filesContext(400));

    const payload = analysisPayload(result.content);
    expect(payload).toMatchObject({
      note: expect.stringMatching(/output limit is too small/i),
      matchesTruncated: true,
      excerptTruncated: true,
      matches: [],
    });
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(untrustedOutputBudget(400));
  });
});

describe('F6 - diagnostics never claim an untested authentication', () => {
  it('reports no_credential when the endpoint was reached without an API key', async () => {
    const executor = executorFor({
      ok: true,
      baseUrl: 'https://model.example.invalid/v1',
      modelId: 'mock-model',
      stages: [
        ...baseStages.filter((stage) => stage.stage !== 'auth'),
        { stage: 'auth', status: 'ok', message: 'The endpoint accepted the request without an API key.' },
      ],
      credentialUsed: false,
      capabilities: capabilities(),
    });

    const result = await executor.execute(diagnosticsCall(), context());
    const report = JSON.parse(result.content) as {
      fullyVerified: boolean;
      verified: Record<string, boolean>;
      authentication: { mode: string; verified: boolean; detail: string };
      verifiedScope: string;
    };

    expect(report.verified.authentication).toBe(false);
    expect(report.authentication.mode).toBe('no_credential');
    expect(report.authentication.verified).toBe(false);
    expect(report.authentication.detail).toMatch(/not exercised/i);
    expect(report.fullyVerified).toBe(false);
    expect(report.verifiedScope).toMatch(/notVerifiedByThisCheck/);
    expect(result.summary).toContain('authentication not verified (no API key was used)');
    expect(result.summary).not.toMatch(/authentication verified with an API key/i);
  });

  it('treats a missing credentialUsed field as untested, not as verified', async () => {
    const executor = executorFor({
      ok: true,
      baseUrl: 'https://model.example.invalid/v1',
      stages: baseStages,
      capabilities: capabilities(),
    });
    const report = JSON.parse((await executor.execute(diagnosticsCall(), context())).content) as {
      verified: Record<string, boolean>;
    };
    expect(report.verified.authentication).toBe(false);
  });

  it('claims authentication only when a credential was used and the auth stage passed', async () => {
    const executor = executorFor({
      ok: true,
      baseUrl: 'https://model.example.invalid/v1',
      stages: baseStages,
      credentialUsed: true,
      capabilities: capabilities(),
    });
    const result = await executor.execute(diagnosticsCall(), context());
    const report = JSON.parse(result.content) as {
      verified: Record<string, boolean>;
      authentication: { mode: string; verified: boolean };
    };
    expect(report.verified.authentication).toBe(true);
    expect(report.authentication).toMatchObject({ mode: 'api_key_verified', verified: true });
    expect(result.summary).toContain('authentication verified with an API key');
  });
});

describe('F2/F3 - files_analyze reports its query and match limits truthfully', () => {
  const manyLines = 'revenue row 0\n' + Array.from({ length: 49 }, (_, index) => `revenue row ${index + 1}`).join('\n');

  it('propagates matchesTruncated and a truthful summary for more than 20 matches', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'many.txt', mediaType: 'text/plain',
      bytes: new TextEncoder().encode(manyLines), conversationId: 'conversation-1',
    });
    const result = await filesExecutor(vault).execute(
      analyzeCall(file.id, 'revenue'), filesContext(DEFAULT_TOOL_LIMITS.maxOutputBytes),
    );
    const payload = analysisPayload(result.content);

    expect(payload.matches).toHaveLength(20);
    expect(payload.matchesTruncated).toBe(true);
    expect(payload.matchesFound).toBeNull();
    expect(result.summary).toContain('more matching lines omitted');
    expect(result.summary).not.toMatch(/exactly 20/i);
  });

  it('does not set truncation flags for a control case under the cap', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'few.txt', mediaType: 'text/plain',
      bytes: new TextEncoder().encode('revenue 1\nrevenue 2\n'), conversationId: 'conversation-1',
    });
    const result = await filesExecutor(vault).execute(
      analyzeCall(file.id, 'revenue'), filesContext(DEFAULT_TOOL_LIMITS.maxOutputBytes),
    );
    const payload = analysisPayload(result.content);
    expect(payload.matchesTruncated).toBeUndefined();
    expect(payload.matchesFound).toBe(2);
    expect(result.summary).not.toMatch(/more matching lines omitted/i);
  });

  it('says the file was not searched when the question has no usable term', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'relevant.txt', mediaType: 'text/plain',
      bytes: new TextEncoder().encode('a highly relevant line\n'), conversationId: 'conversation-1',
    });
    const result = await filesExecutor(vault).execute(
      analyzeCall(file.id, 'What is the file about?'), filesContext(DEFAULT_TOOL_LIMITS.maxOutputBytes),
    );
    const payload = analysisPayload(result.content) as {
      query: { matchesEvaluated: boolean; reason: string; keywords: string[]; note: string };
      matchesTruncated?: boolean;
    };

    expect(payload.query.matchesEvaluated).toBe(false);
    expect(payload.query.reason).toBe('no_usable_terms');
    expect(payload.query.keywords).toEqual([]);
    expect(payload.query.note).toMatch(/not evidence/i);
    expect(payload.matchesTruncated).toBeUndefined();
    expect(result.summary).toContain('matches were not evaluated');
    expect(result.summary).not.toContain('0 matching line(s)');
  });

  it('surfaces keyword-limit and script-window diagnostics in the payload and summary', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'cjk.txt', mediaType: 'text/plain',
      bytes: new TextEncoder().encode('结论：销售额上升\n预算：1000\n'), conversationId: 'conversation-1',
    });
    const result = await filesExecutor(vault).execute(
      analyzeCall(file.id, '请分析这个文件中的数据分布情况和主要结论'),
      filesContext(DEFAULT_TOOL_LIMITS.maxOutputBytes),
    );
    const payload = analysisPayload(result.content) as {
      query: { keywordsLimited: boolean; scriptWindows: boolean; keywords: string[] };
      matches: Array<{ text: string }>;
    };
    expect(payload.query.keywordsLimited).toBe(true);
    expect(payload.query.scriptWindows).toBe(true);
    expect(payload.query.keywords).toContain('结论');
    expect(payload.matches.some((match) => match.text.includes('结论'))).toBe(true);
    expect(result.summary).toContain('keyword search limited to 6 terms');
    expect(result.summary).toContain('bounded two-character windows');
  });
});

describe('F4 - the files_analyze output is valid at every output budget', () => {
  const trickyText = [
    'alpha "quoted" and C:\\path\\to\\file',
    'newline\ninside a field and emoji 🚀 and café 汉字',
    ...Array.from({ length: 40 }, (_, index) => `revenue row ${index} with "quotes" and a backslash \\`),
  ].join('\n');

  it.each([1, 150, 256, 300, 323, 324, 400])(
    'budget %i stays inside the wrapped budget and never returns broken JSON',
    async (budget) => {
      const vault = new FileVault();
      const file = await vault.upload({
        name: 'tricky.txt', mediaType: 'text/plain',
        bytes: new TextEncoder().encode(trickyText), conversationId: 'conversation-1',
      });
      const result = await filesExecutor(vault).execute(analyzeCall(file.id, 'revenue'), filesContext(budget));
      const wrapped = wrapUntrustedOutput(result.content, budget);

      expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(untrustedOutputBudget(budget));
      expect(Buffer.byteLength(wrapped, 'utf8')).toBeLessThanOrEqual(budget);

      if (result.content.includes('{')) {
        // Any JSON document reaching the model must be complete and parseable
        // after the exact same wrapping path production uses.
        const payload = analysisPayload(wrapped);
        expect(payload).toBeTypeOf('object');
        expect(payload.matchesTruncated).toBe(true);
        expect(String(payload.note ?? '')).toMatch(/limit/i);
        expect(result.summary).not.toMatch(/plain text only/i);
      } else {
        // Below the minimum JSON size the result is explicitly plain text.
        expect(result.summary).toMatch(/plain text only/i);
        expect(result.content).not.toContain('matchesTruncated');
      }
    },
  );

  it('still returns a complete normal JSON document at the default budget with tricky content', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'tricky.txt', mediaType: 'text/plain',
      bytes: new TextEncoder().encode(trickyText), conversationId: 'conversation-1',
    });
    const result = await filesExecutor(vault).execute(
      analyzeCall(file.id, 'revenue'), filesContext(DEFAULT_TOOL_LIMITS.maxOutputBytes),
    );
    const payload = analysisPayload(wrapUntrustedOutput(result.content, DEFAULT_TOOL_LIMITS.maxOutputBytes));
    expect(typeof payload.excerpt).toBe('string');
    expect(payload.matchesTruncated).toBe(true);
    expect(payload.query).toMatchObject({ matchesEvaluated: true });
  });
});
