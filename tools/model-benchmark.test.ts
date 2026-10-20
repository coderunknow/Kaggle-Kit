import { describe, expect, it } from 'vitest';

import {
  BENCHMARK_TOOLS,
  SELECTION_TASK,
  buildReport,
  checkNoToolUse,
  checkSelectionAndArguments,
  checkSyntheticFollowUp,
  createToolCallAccumulator,
  evaluateExpression,
  findSecretLeaks,
  layerSummary,
  makeResult,
  parseBenchmarkArgs,
  redactSecretDisplay,
  sanitizeEndpointIdentity,
  summarizeResults,
} from './model-benchmark-core.mjs';

function completion(toolCalls: unknown[], finishReason: string, content: string | null = null) {
  return {
    choices: [{
      message: { role: 'assistant', content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
      finish_reason: finishReason,
    }],
  };
}

function calcCall(expression: string, id = 'call-1') {
  return { id, type: 'function', function: { name: 'calculator_calculate', arguments: JSON.stringify({ expression }) } };
}

describe('benchmark CLI argument handling', () => {
  it('rejects every attempt to pass a secret on the command line', () => {
    for (const flag of ['--api-key', '--apikey', '--key', '--token', '--authorization']) {
      const { errors } = parseBenchmarkArgs(['--base-url', 'https://x.example/v1', '--model', 'm', flag, 'sk-secret']);
      expect(errors.join(' ')).toMatch(/never be passed as command-line arguments/i);
    }
  });

  it('accepts a valid configuration and bounds the trials', () => {
    const { options, errors } = parseBenchmarkArgs(['--base-url', 'https://x.example/v1', '--model', 'm', '--trials', '5', '--include-streaming']);
    expect(errors).toEqual([]);
    expect(options.trials).toBe(5);
    expect(options.includeStreaming).toBe(true);
    expect(parseBenchmarkArgs(['--base-url', 'u', '--model', 'm', '--trials', '0']).errors.length).toBeGreaterThan(0);
    expect(parseBenchmarkArgs(['--base-url', 'u', '--model', 'm', '--trials', '21']).errors.length).toBeGreaterThan(0);
  });

  it('requires the endpoint and the model', () => {
    expect(parseBenchmarkArgs([]).errors.join(' ')).toMatch(/--base-url/);
    expect(parseBenchmarkArgs(['--base-url', 'u']).errors.join(' ')).toMatch(/--model/);
  });
});

describe('benchmark report hygiene', () => {
  it('records a sanitized endpoint identity and never the credential value', () => {
    expect(sanitizeEndpointIdentity('https://user:pass@model.example:8080/v1?x=1#f')).toBe('https://model.example:8080/v1');
    expect(sanitizeEndpointIdentity('not a url')).toBe('invalid-url');
    expect(redactSecretDisplay('sk-super-secret-value')).toBe('[redacted API key, length 21]');
    expect(redactSecretDisplay('')).toMatch(/no API key/i);

    const report = buildReport({
      mode: 'model',
      baseUrl: 'https://user:pass@model.example/v1',
      model: 'qwen-test',
      apiKey: 'sk-super-secret-value',
      trials: 1,
      startedAt: 'a',
      finishedAt: 'b',
      requestSettings: {},
      results: [makeResult('handshake', 1, 'passed', 'protocol', 'ok')],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sk-super-secret-value');
    expect(serialized).not.toContain('pass@');
    expect(report.endpoint).toBe('https://model.example/v1');
    expect(report.layers.protocol).toBe('verified');
    expect(report.interpretation).toMatch(/SYNTHETIC/i);
    expect(findSecretLeaks(report, ['sk-super-secret-value'])).toEqual([]);
    expect(findSecretLeaks({ leaked: 'sk-super-secret-value' }, ['sk-super-secret-value'])).toEqual(['sk-super-secret-value']);
  });

  it('never counts skipped or blocked cases as passed and reports sample counts', () => {
    const summary = summarizeResults([
      makeResult('case_a', 1, 'passed', 'protocol', 'ok'),
      makeResult('case_a', 2, 'failed', 'protocol', 'bad'),
      makeResult('case_b', 1, 'skipped', 'end_to_end', 'not configured'),
      makeResult('case_c', 1, 'blocked', 'protocol', 'unsupported'),
    ]);
    expect(summary.totals).toMatchObject({ passed: 1, failed: 1, blocked: 1, skipped: 1 });
    const caseA = summary.cases.find((entry: { caseId: string }) => entry.caseId === 'case_a');
    expect(caseA?.score).toBe('1/2 attempted trial(s) passed');
    const caseB = summary.cases.find((entry: { caseId: string }) => entry.caseId === 'case_b');
    expect(caseB?.score).toMatch(/no attempted trials/i);
  });

  it('keeps the evidence layers apart', () => {
    const layers = layerSummary([
      makeResult('handshake', 1, 'passed', 'protocol', 'ok'),
      makeResult('selection', 1, 'failed', 'selection', 'wrong tool'),
      makeResult('exec', 1, 'skipped', 'execution', 'no docker'),
    ]);
    expect(layers).toMatchObject({ protocol: 'verified', selection: 'failed', execution: 'skipped', arguments: 'not_proven', end_to_end: 'not_proven' });
  });
});

describe('benchmark semantic checks', () => {
  it('evaluates arithmetic deterministically without eval', () => {
    expect(evaluateExpression('17 * 23 + 101')).toBe(492);
    // ^ binds tighter than *, like the documented calculator grammar.
    expect(evaluateExpression('(2 + 3) * 4 ^ 2')).toBe(80);
    expect(evaluateExpression('((2 + 3) * 4) ^ 2')).toBe(400);
    expect(evaluateExpression('10 % 3')).toBe(1);
    expect(() => evaluateExpression('process.exit()')).toThrow(/unsupported characters/i);
    expect(() => evaluateExpression('1 +')).toThrow();
    expect(() => evaluateExpression('1e999 * 1e999')).toThrow(/unsupported characters|non-finite/i);
  });

  it('separates protocol, selection and argument verdicts', () => {
    const good = checkSelectionAndArguments(completion([calcCall('17 * 23 + 101')], 'tool_calls'));
    expect(good).toMatchObject({ protocolOk: true, selectionOk: true, argumentsOk: true, value: 492 });

    const wrongTool = checkSelectionAndArguments(completion([{ id: 'c', type: 'function', function: { name: 'web_search', arguments: '{"query":"17*23+101"}' } }], 'tool_calls'));
    expect(wrongTool).toMatchObject({ protocolOk: true, selectionOk: false, argumentsOk: false });
    expect(wrongTool.details.join(' ')).toMatch(/web_search/);

    const badArgs = checkSelectionAndArguments(completion([calcCall('17 * 23')], 'tool_calls'));
    expect(badArgs).toMatchObject({ selectionOk: true, argumentsOk: false });
    expect(badArgs.details.join(' ')).toMatch(/evaluates to 391/);

    const wrongFinish = checkSelectionAndArguments(completion([calcCall('17 * 23 + 101')], 'stop'));
    expect(wrongFinish.protocolOk).toBe(false);
    expect(wrongFinish.details.join(' ')).toMatch(/finish_reason/);

    const plainText = checkSelectionAndArguments(completion([], 'stop', 'The answer is 492.'));
    expect(plainText).toMatchObject({ selectionOk: false, argumentsOk: false });
    expect(plainText.details.join(' ')).toMatch(/plain text/);
  });

  it('fails a negative-selection case when the model calls a tool anyway', () => {
    expect(checkNoToolUse(completion([], 'stop', 'Paris.')).ok).toBe(true);
    expect(checkNoToolUse(completion([calcCall('1+1')], 'tool_calls')).ok).toBe(false);
    expect(checkNoToolUse(completion([], 'stop', '')).ok).toBe(false);
  });

  it('requires an honest final answer after a synthetic result', () => {
    expect(checkSyntheticFollowUp(completion([], 'stop', 'The result is 492.'), 492).ok).toBe(true);
    expect(checkSyntheticFollowUp(completion([], 'stop', 'The result is 500.'), 492).ok).toBe(false);
    expect(checkSyntheticFollowUp(completion([calcCall('1+1')], 'tool_calls', null), 492).ok).toBe(false);
    expect(checkSyntheticFollowUp(completion([], 'length', 'The result is 492.'), 492).ok).toBe(false);
  });

  it('assembles streamed tool-call fragments in index order', () => {
    const accumulator = createToolCallAccumulator();
    accumulator.add({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-9', function: { name: 'calculator_' } }] } }] });
    accumulator.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'calculate', arguments: '{"expr' } }] } }] });
    accumulator.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ession":"1+1"}' } }] }, finish_reason: 'tool_calls' }] });
    const calls = accumulator.finish();
    expect(calls).toEqual([{ id: 'call-9', name: 'calculator_calculate', arguments: '{"expression":"1+1"}' }]);
  });

  it('offers an unambiguous target tool plus one distractor', () => {
    expect(BENCHMARK_TOOLS.map((tool: { function: { name: string } }) => tool.function.name)).toContain(SELECTION_TASK.expectedTool);
    expect(BENCHMARK_TOOLS).toHaveLength(2);
  });
});
