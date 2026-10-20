#!/usr/bin/env node
/**
 * Live-model tool-calling benchmark for Kaggle-Kit.
 *
 * Run this against the operator's real OpenAI-compatible endpoint to find out
 * which layer of the tool-calling stack fails. It answers questions a mock
 * cannot: does the deployed model actually select the right tool, with valid
 * arguments, and accept a tool result without inventing actions?
 *
 * Safety rules enforced here:
 *  - credentials come from the environment or a masked interactive prompt,
 *    never from command-line arguments (which leak via ps/history),
 *  - the report never contains a key value; a final leak check refuses to
 *    write a report that does,
 *  - model mode feeds the model SYNTHETIC tool results only and labels them
 *    as synthetic; no Kaggle-Kit executor runs in model mode,
 *  - integration mode never approves a code execution: the approval case
 *    exercises the DENIAL path,
 *  - skipped and blocked cases are reported as themselves, never as passed.
 *
 * Usage and interpretation: node tools/model-benchmark.mjs --help
 */

import fs from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

import {
  BENCHMARK_TOOLS,
  HANDSHAKE_OK_TEXT,
  HANDSHAKE_TOOL,
  NEGATIVE_TASK,
  SELECTION_TASK,
  SYNTHETIC_MARKER,
  USAGE,
  buildReport,
  checkNoToolUse,
  checkSelectionAndArguments,
  checkSyntheticFollowUp,
  createToolCallAccumulator,
  findSecretLeaks,
  isProtocolRejection,
  makeResult,
  parseBenchmarkArgs,
  redactSecretDisplay,
  sanitizeEndpointIdentity,
  summarizeResults,
} from './model-benchmark-core.mjs';

const argv = process.argv.slice(2);
const { options: cli, errors } = parseBenchmarkArgs(argv);

if (cli.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const env = process.env;
const baseUrl = (cli.baseUrl || env.OPENAI_BASE_URL || env.KAGGLE_KIT_MODEL_URL || '').trim();
const model = (cli.model || env.OPENAI_MODEL || env.KAGGLE_KIT_MODEL_ID || '').trim();
const origin = (cli.origin || env.KAGGLE_KIT_ORIGIN || 'http://127.0.0.1:8787').replace(/\/$/, '');
if (errors.length > 0 || !baseUrl || !model) {
  for (const error of errors.length > 0 ? errors : []) process.stderr.write(`error: ${error}\n`);
  if (!baseUrl) process.stderr.write('error: A --base-url (or OPENAI_BASE_URL / KAGGLE_KIT_MODEL_URL) is required.\n');
  if (!model) process.stderr.write('error: A --model (or OPENAI_MODEL / KAGGLE_KIT_MODEL_ID) is required.\n');
  process.stderr.write('\n' + USAGE);
  process.exit(2);
}

const knownSecrets = [];
let apiKey = (env.OPENAI_API_KEY || env.KAGGLE_KIT_MODEL_API_KEY || '').trim();
if (!apiKey && cli.prompt && process.stdin.isTTY) {
  apiKey = await promptSecret('API key for the model endpoint (input is hidden; press Enter for none): ');
}
if (apiKey) knownSecrets.push(apiKey);

const startedAt = new Date().toISOString();
process.stdout.write(`kaggle-kit model benchmark\n`);
process.stdout.write(`  endpoint: ${sanitizeEndpointIdentity(baseUrl)}\n`);
process.stdout.write(`  model:    ${model}\n`);
process.stdout.write(`  key:      ${redactSecretDisplay(apiKey)}\n`);
process.stdout.write(`  mode:     ${cli.mode}, trials: ${cli.trials}\n\n`);

const results = [];
let protocolRejected = false;
let protocolRejectionReason = '';

if (cli.mode === 'model') {
  await runModelMode();
} else {
  await runIntegrationMode();
}

const finishedAt = new Date().toISOString();
const requestSettings = {
  temperature: 0,
  topP: 1,
  stream: false,
  parallel_tool_calls: false,
  toolsOffered: cli.mode === 'model'
    ? [...BENCHMARK_TOOLS.map((tool) => tool.function.name), HANDSHAKE_TOOL.function.name]
    : ['server-governed catalog of the configured profile'],
  maxTokensPerRequest: 512,
};
const report = buildReport({
  mode: cli.mode,
  baseUrl,
  model,
  apiKey,
  trials: cli.trials,
  startedAt,
  finishedAt,
  requestSettings,
  results,
});

const leaks = findSecretLeaks(report, knownSecrets);
if (leaks.length > 0) {
  process.stderr.write('error: the report would contain credential material; it was NOT written or printed in full.\n');
  process.exit(2);
}

printReport(report);
if (cli.reportPath) {
  fs.writeFileSync(cli.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nJSON report written to ${cli.reportPath}\n`);
}

const { totals } = summarizeResults(results);
if (totals.failed > 0) process.exit(1);
process.exit(0);

// ---------------------------------------------------------------------------
// Model mode: direct requests against the OpenAI-compatible endpoint.
// ---------------------------------------------------------------------------

async function runModelMode() {
  for (let trial = 1; trial <= cli.trials && !protocolRejected; trial += 1) {
    process.stdout.write(`-- trial ${trial}/${cli.trials}\n`);

    // 1. Harmless native tool-call handshake (protocol layer), mirroring the
    //    server probe: one valid call, then a synthetic result, then a final
    //    stop answer with the exact sentinel. Nothing is ever executed.
    const handshake = await runCase('handshake', trial, 'protocol', async () => {
      const messages = [
        { role: 'system', content: 'This is an isolated no-op capability probe. Never perform external actions. Call the named function exactly once with an empty object. After receiving the synthetic tool result, do not call a function again; reply with exactly KAGGLE_KIT_TOOL_PROBE_OK.' },
        { role: 'user', content: `Call the function named ${HANDSHAKE_TOOL.function.name} exactly once with an empty JSON object. The function is harmless and will not be executed.` },
      ];
      const first = await chatCompletion({ messages, tools: [HANDSHAKE_TOOL], maxTokens: 64 });
      if (first.blocked) return first;
      const choice = first.completion?.choices?.[0];
      const call = choice?.message?.tool_calls?.[0];
      if (choice?.finish_reason !== 'tool_calls' || call?.function?.name !== HANDSHAKE_TOOL.function.name || typeof call.id !== 'string' || !call.id) {
        return { outcome: 'failed', reason: `The handshake did not return one valid ${HANDSHAKE_TOOL.function.name} call with finish_reason=tool_calls (got finish_reason="${choice?.finish_reason ?? 'missing'}").` };
      }
      let argsOk = false;
      try {
        const parsed = JSON.parse(call.function.arguments);
        argsOk = Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
      } catch { /* unparsable arguments keep argsOk false */ }
      if (!argsOk) return { outcome: 'failed', reason: 'The handshake call arguments were not an empty JSON object.' };
      const follow = await chatCompletion({
        messages: [
          ...messages,
          { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: HANDSHAKE_TOOL.function.name, arguments: '{}' } }] },
          { role: 'tool', tool_call_id: call.id, name: HANDSHAKE_TOOL.function.name, content: JSON.stringify({ ok: true, result: SYNTHETIC_MARKER }) },
        ],
        tools: [HANDSHAKE_TOOL],
        maxTokens: 64,
      });
      if (follow.blocked) return follow;
      const finalChoice = follow.completion?.choices?.[0];
      const noMoreCalls = !Array.isArray(finalChoice?.message?.tool_calls) || finalChoice.message.tool_calls.length === 0;
      const text = typeof finalChoice?.message?.content === 'string' ? finalChoice.message.content.trim() : '';
      if (finalChoice?.finish_reason === 'stop' && noMoreCalls && text === HANDSHAKE_OK_TEXT) {
        return { outcome: 'passed', reason: 'Two-step native tool round trip completed with a synthetic result; the function was never executed.' };
      }
      return { outcome: 'failed', reason: `The synthetic follow-up did not end with finish_reason=stop and "${HANDSHAKE_OK_TEXT}" (got "${text.slice(0, 80)}").` };
    });
    if (handshake.blocked) continue;

    // 2. Tool selection + argument semantics for an unambiguous task.
    await runCase(SELECTION_TASK.id, trial, 'selection', async () => {
      const response = await chatCompletion({
        messages: [{ role: 'user', content: SELECTION_TASK.prompt }],
        tools: BENCHMARK_TOOLS,
        maxTokens: 512,
      });
      if (response.blocked) return response;
      const check = checkSelectionAndArguments(response.completion);
      if (!check.protocolOk && !check.selectionOk) {
        return { outcome: 'failed', reason: `Protocol shape wrong and no valid selection: ${check.details.join(' ')}` };
      }
      if (!check.selectionOk) return { outcome: 'failed', reason: check.details.join(' ') };
      if (!check.argumentsOk) {
        results.push(makeResult('argument_correctness', trial, 'failed', 'arguments', check.details.join(' ')));
        return { outcome: 'passed', reason: `Selected ${SELECTION_TASK.expectedTool}; arguments failed the semantic/schema check (recorded separately).` };
      }
      results.push(makeResult('argument_correctness', trial, 'passed', 'arguments', `expression evaluated to ${check.value}, matching the expected ${SELECTION_TASK.expectedValue}.`));
      return { outcome: 'passed', reason: `Selected ${SELECTION_TASK.expectedTool} with a schema-valid expression evaluating to ${SELECTION_TASK.expectedValue}.` };
    });

    // 3. Synthetic tool result accepted, final answer honest (protocol layer).
    await runCase('synthetic_final_answer', trial, 'protocol', async () => {
      const fakeCallId = `bench-${trial}-calc`;
      const response = await chatCompletion({
        messages: [
          { role: 'system', content: 'You are given a SYNTHETIC benchmark tool result. It was produced by the benchmark harness, not by a real execution. Use it to answer, then stop. Never claim you performed a real-world action yourself.' },
          { role: 'user', content: SELECTION_TASK.prompt },
          { role: 'assistant', content: null, tool_calls: [{ id: fakeCallId, type: 'function', function: { name: SELECTION_TASK.expectedTool, arguments: JSON.stringify({ expression: '17 * 23 + 101' }) } }] },
          { role: 'tool', tool_call_id: fakeCallId, name: SELECTION_TASK.expectedTool, content: JSON.stringify({ ok: true, display: String(SELECTION_TASK.expectedValue), synthetic: SYNTHETIC_MARKER }) },
        ],
        tools: BENCHMARK_TOOLS,
        maxTokens: 512,
      });
      if (response.blocked) return response;
      const check = checkSyntheticFollowUp(response.completion, SELECTION_TASK.expectedValue);
      return check.ok
        ? { outcome: 'passed', reason: 'The model accepted the clearly-marked synthetic result and produced a final stop answer mentioning the value.' }
        : { outcome: 'failed', reason: check.details.join(' ') };
    });

    // 4. Negative selection: an ordinary question must not trigger a tool.
    await runCase(NEGATIVE_TASK.id, trial, 'selection', async () => {
      const response = await chatCompletion({
        messages: [{ role: 'user', content: NEGATIVE_TASK.prompt }],
        tools: BENCHMARK_TOOLS,
        maxTokens: 128,
      });
      if (response.blocked) return response;
      const check = checkNoToolUse(response.completion);
      return check.ok
        ? { outcome: 'passed', reason: 'No tool call for a question that needs none; a plain answer was returned.' }
        : { outcome: 'failed', reason: check.details.join(' ') };
    });

    // 5. Optional streamed tool-call fragment verification.
    if (cli.includeStreaming) {
      await runCase('streaming_handshake', trial, 'protocol', async () => {
        const outcome = await streamedToolCallProbe();
        return outcome;
      });
    }
  }
  if (protocolRejected) {
    process.stdout.write(`\nNOTE: the endpoint rejected the tool protocol (${protocolRejectionReason}). Remaining trials were marked blocked: tool-calling support is disproven or absent, which is different from a model that supports the protocol but fails the behavioural benchmark.\n`);
  }
}

async function runCase(caseId, trial, layer, body) {
  try {
    const verdict = await body();
    if (verdict.blocked) {
      protocolRejected = true;
      protocolRejectionReason = verdict.reason;
      results.push(makeResult(caseId, trial, 'blocked', layer, verdict.reason));
      process.stdout.write(`   ${caseId}: BLOCKED (${verdict.reason})\n`);
      return { blocked: true };
    }
    results.push(makeResult(caseId, trial, verdict.outcome, layer, verdict.reason));
    process.stdout.write(`   ${caseId}: ${verdict.outcome.toUpperCase()} — ${verdict.reason}\n`);
    return { blocked: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    results.push(makeResult(caseId, trial, 'failed', layer, `Request error: ${reason}`));
    process.stdout.write(`   ${caseId}: FAILED — request error: ${reason}\n`);
    return { blocked: false };
  }
}

async function chatCompletion({ messages, tools, maxTokens }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cli.timeoutMs);
  try {
    const response = await fetch(new URL('chat/completions', withTrailingSlash(baseUrl)), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
        max_tokens: maxTokens,
        temperature: 0,
        top_p: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (isProtocolRejection(response.status) && tools) {
      const body = await safeText(response);
      return { blocked: true, reason: `HTTP ${response.status} on a tool request — the endpoint does not support the native tool protocol: ${body.slice(0, 200)}` };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await safeText(response)).slice(0, 200)}`);
    const completion = await response.json();
    return { completion };
  } finally {
    clearTimeout(timer);
  }
}

async function streamedToolCallProbe() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(cli.timeoutMs, 30_000));
  try {
    const response = await fetch(new URL('chat/completions', withTrailingSlash(baseUrl)), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Isolated no-op probe. Call the named function exactly once with an empty object.' },
          { role: 'user', content: `Call ${HANDSHAKE_TOOL.function.name} with an empty JSON object.` },
        ],
        tools: [HANDSHAKE_TOOL],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        max_tokens: 64,
        temperature: 0,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (isProtocolRejection(response.status)) {
      return { blocked: true, reason: `HTTP ${response.status} on a streamed tool request.` };
    }
    if (!response.ok || !response.body) return { outcome: 'failed', reason: `Streamed probe returned HTTP ${response.status} without a body.` };
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      return { outcome: 'failed', reason: `Streamed probe content type was "${response.headers.get('content-type') ?? 'unknown'}", not text/event-stream.` };
    }
    const accumulator = createToolCallAccumulator();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason;
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            finishReason = accumulator.add(JSON.parse(payload)) ?? finishReason;
          } catch { /* ignore keep-alive noise */ }
        }
      }
      if (finishReason) break;
    }
    const calls = accumulator.finish();
    if (calls.length === 1 && calls[0].name === HANDSHAKE_TOOL.function.name) {
      try {
        const parsed = JSON.parse(calls[0].arguments);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length === 0) {
          return { outcome: 'passed', reason: 'Streamed tool-call fragments assembled into one valid call.' };
        }
      } catch { /* falls through to failed */ }
    }
    return { outcome: 'failed', reason: `Streamed fragments did not assemble into the expected call (got ${calls.length} call(s), finish_reason="${finishReason ?? 'missing'}").` };
  } catch (error) {
    return { outcome: 'failed', reason: `Streamed probe error: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Integration mode: through a running Kaggle-Kit proxy.
// ---------------------------------------------------------------------------

async function runIntegrationMode() {
  const health = await proxyFetch('GET', '/api/health', undefined, 5_000).catch(() => undefined);
  if (!health || health.status !== 200) {
    const reason = `The Kaggle-Kit proxy at ${origin} did not answer /api/health; start it (npm start) with a configured tool profile. Nothing was tested.`;
    const skipLayers = { proxy_capability: 'protocol', integration_calculator: 'end_to_end', integration_python_denial: 'execution' };
    for (const [caseId, layer] of Object.entries(skipLayers)) {
      results.push(makeResult(caseId, 1, 'skipped', layer, reason));
    }
    process.stdout.write(`   integration: SKIPPED — ${reason}\n`);
    return;
  }

  // Capability probe through the proxy (the same route the UI uses).
  const capability = await proxyFetch('POST', '/api/tools/capability', { baseUrl, model, ...(apiKey ? { apiKey } : {}), timeoutMs: cli.timeoutMs }, cli.timeoutMs + 5_000).catch((error) => ({ error }));
  if (capability?.error) {
    results.push(makeResult('proxy_capability', 1, 'skipped', 'protocol', `The proxy request failed: ${capability.error.message ?? capability.error}`));
  } else if (capability.body?.status === 'supported_verified') {
    results.push(makeResult('proxy_capability', 1, 'passed', 'protocol', `The proxy probe verified native tool calling: ${String(capability.body.detail ?? '').slice(0, 160)}`));
  } else {
    results.push(makeResult('proxy_capability', 1, 'failed', 'protocol', `The proxy probe reported "${capability.body?.status ?? 'unknown'}": ${String(capability.body?.detail ?? '').slice(0, 200)}`));
  }
  process.stdout.write(`   proxy_capability: ${results[results.length - 1].outcome.toUpperCase()}\n`);

  if (!cli.profileId) {
    const reason = '--profile-id was not provided; the application integration cases were skipped, not passed.';
    results.push(makeResult('integration_calculator', 1, 'skipped', 'end_to_end', reason));
    results.push(makeResult('integration_python_denial', 1, 'skipped', 'execution', reason));
    process.stdout.write(`   integration cases: SKIPPED — ${reason}\n`);
    return;
  }
  const conversationId = cli.conversationId || `bench-${Date.now().toString(36)}`;

  // Real tool loop: automatic read-only calculator execution, server-governed.
  const chatBody = {
    profileId: cli.profileId,
    conversationId,
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    messages: [{ role: 'user', content: SELECTION_TASK.prompt }],
    params: { maxTokens: 512, temperature: 0, topP: 1, stream: false },
    timeoutMs: cli.timeoutMs,
  };
  const chat = await proxyFetch('POST', '/api/tools/chat', chatBody, cli.timeoutMs + 15_000).catch((error) => ({ error }));
  if (chat?.error) {
    results.push(makeResult('integration_calculator', 1, 'skipped', 'end_to_end', `The proxy tool-chat request failed: ${chat.error.message ?? chat.error}`));
  } else if (chat.status === 409) {
    results.push(makeResult('integration_calculator', 1, 'skipped', 'end_to_end', `The proxy refused the tool chat (HTTP 409): ${String(chat.body?.error ?? chat.body?.message ?? '').slice(0, 200)} — enable tools for this profile and verify capability first.`));
  } else if (chat.status === 200) {
    const trace = Array.isArray(chat.body?.toolTrace) ? chat.body.toolTrace : [];
    const calc = trace.find((entry) => entry.toolName === 'calculator_calculate');
    const content = String(chat.body?.content ?? '');
    if (calc?.status === 'succeeded' && content.includes('492')) {
      results.push(makeResult('integration_calculator', 1, 'passed', 'end_to_end', 'The real Kaggle-Kit tool loop selected, executed and reported the calculator result end to end.'));
    } else if (calc?.status === 'failed') {
      results.push(makeResult('integration_calculator', 1, 'failed', 'execution', `The calculator call reached execution but failed: ${String(calc.error ?? calc.resultSummary ?? '').slice(0, 200)}`));
    } else if (trace.length === 0) {
      results.push(makeResult('integration_calculator', 1, 'failed', 'selection', `The model completed without calling any tool (recovery: ${JSON.stringify(chat.body?.recovery ?? null)}).`));
    } else {
      results.push(makeResult('integration_calculator', 1, 'failed', 'end_to_end', `The trace did not show a succeeded calculator call and a 492 answer: ${JSON.stringify(trace.map((entry) => ({ tool: entry.toolName, status: entry.status }))).slice(0, 200)}`));
    }
  } else {
    results.push(makeResult('integration_calculator', 1, 'failed', 'end_to_end', `The proxy answered HTTP ${chat.status}: ${JSON.stringify(chat.body ?? {}).slice(0, 200)}`));
  }
  process.stdout.write(`   integration_calculator: ${results[results.length - 1].outcome.toUpperCase()} — ${results[results.length - 1].reason}\n`);

  // Approval handling: request a Python run and DENY it. Never approved here.
  const pythonBody = {
    ...chatBody,
    conversationId: `${conversationId}-py`,
    messages: [{ role: 'user', content: 'Run this Python code in the sandbox and tell me the output: print("benchmark")' }],
  };
  const python = await proxyFetch('POST', '/api/tools/chat', pythonBody, cli.timeoutMs + 15_000).catch((error) => ({ error }));
  if (python?.error || python?.status !== 200) {
    results.push(makeResult('integration_python_denial', 1, 'skipped', 'execution', python?.error
      ? `The proxy request failed: ${python.error.message ?? python.error}`
      : `The proxy answered HTTP ${python?.status}: ${String(python?.body?.error ?? python?.body?.message ?? '').slice(0, 200)} (code execution may be disabled for this profile).`));
  } else if (python.body?.status !== 'awaiting_approval' || python.body?.pendingApproval?.toolName !== 'code_execute') {
    results.push(makeResult('integration_python_denial', 1, 'failed', 'execution', `Expected an awaiting_approval code_execute pause; got status="${python.body?.status}" with trace ${JSON.stringify((python.body?.toolTrace ?? []).map((entry) => entry.toolName)).slice(0, 120)}`));
    if (python.body?.jobId) await proxyFetch('POST', '/api/tools/cancel', { jobId: python.body.jobId }, 5_000).catch(() => undefined);
  } else {
    const denial = await proxyFetch('POST', '/api/tools/approve', {
      jobId: python.body.jobId,
      approvalId: python.body.pendingApproval.approvalId,
      approved: false,
    }, cli.timeoutMs + 15_000).catch((error) => ({ error }));
    if (denial?.error || denial?.status !== 200) {
      results.push(makeResult('integration_python_denial', 1, 'failed', 'execution', `The denial request failed: ${denial?.error?.message ?? `HTTP ${denial?.status}`}`));
    } else {
      const trace = denial.body?.toolTrace ?? [];
      const denied = trace.some((entry) => entry.toolName === 'code_execute' && entry.status === 'denied');
      const executed = trace.some((entry) => entry.toolName === 'code_execute' && ['approved', 'running', 'succeeded'].includes(entry.status));
      if (denied && !executed) {
        results.push(makeResult('integration_python_denial', 1, 'passed', 'execution', 'The Python run paused for approval, the denial was honoured, and nothing executed.'));
      } else {
        results.push(makeResult('integration_python_denial', 1, 'failed', 'execution', `Denial path misbehaved: denied=${denied}, executed=${executed}.`));
      }
    }
  }
  process.stdout.write(`   integration_python_denial: ${results[results.length - 1].outcome.toUpperCase()} — ${results[results.length - 1].reason}\n`);
}

async function proxyFetch(method, path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, origin), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    let parsed;
    try { parsed = await response.json(); } catch { parsed = undefined; }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Reporting and helpers
// ---------------------------------------------------------------------------

function printReport(report) {
  const { totals, cases } = report.summary;
  process.stdout.write('\n== summary ==\n');
  for (const entry of cases) {
    process.stdout.write(`  ${entry.caseId} [${entry.layer}]: passed ${entry.passed}, failed ${entry.failed}, blocked ${entry.blocked}, skipped ${entry.skipped} — ${entry.score}\n`);
    for (const reason of entry.reasons.slice(0, 3)) process.stdout.write(`      reason: ${reason}\n`);
  }
  process.stdout.write(`\nTotals: ${totals.passed} passed, ${totals.failed} failed, ${totals.blocked} blocked, ${totals.skipped} skipped.\n`);
  process.stdout.write('Evidence layers (a weaker layer never implies a stronger one):\n');
  for (const [layer, state] of Object.entries(report.layers)) {
    process.stdout.write(`  ${layer}: ${state}\n`);
  }
  process.stdout.write(`\n${report.interpretation}\n`);
  if (protocolRejected) {
    process.stdout.write(`Likely failure layer: request construction / endpoint capability (${protocolRejectionReason}).\n`);
  } else if (report.layers.protocol === 'verified' && report.layers.selection === 'failed') {
    process.stdout.write('Likely failure layer: model behaviour — the protocol works but the model does not select the right tool. Consider the corrective-round settings and prompt guidance; this is not a backend execution failure.\n');
  } else if (report.layers.selection === 'verified' && report.layers.arguments === 'failed') {
    process.stdout.write('Likely failure layer: argument generation — the model picks the tool but produces schema-invalid or semantically wrong arguments.\n');
  }
}

async function promptSecret(question) {
  if (!process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let asked = false;
    // Echo the question once, then swallow every typed character: the secret
    // must never appear on the terminal, in logs, or in scrollback.
    rl._writeToOutput = (value) => {
      if (!asked) {
        rl.output.write(question);
        asked = true;
      } else if (value === '\r\n' || value === '\n') {
        rl.output.write('\r\n');
      }
    };
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function safeText(response) {
  try { return await response.text(); } catch { return ''; }
}

function withTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}
