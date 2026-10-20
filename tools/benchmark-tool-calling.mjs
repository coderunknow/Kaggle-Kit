#!/usr/bin/env node
/**
 * Real-Model & Application Integration Tool-Calling Benchmark / Diagnostic CLI
 * ============================================================================
 *
 * Verifies tool-calling reliability in two distinct, explicitly separated phases:
 *
 *   1. Model-Only Mode (`--mode model`):
 *      Talks directly to an OpenAI-compatible `llama-server` endpoint (such as
 *      a live Kaggle T4 x2 tunnel or local server) and measures:
 *        - Native 2-step capability handshake (`kaggle_kit_capability_probe`)
 *        - Streamed tool-call fragment assembly (`text/event-stream`)
 *        - Unambiguous tool selection across representative prompts
 *        - JSON argument schema & semantic validation
 *        - Synthetic tool result acceptance (explicitly labelled synthetic)
 *        - Restraint on non-tool conversational turns
 *        - Multi-trial pass/recovery/failure counts
 *
 *   2. Application Integration Mode (`--mode integration`):
 *      Exercises the actual Kaggle-Kit backend proxy (`ToolChatService` +
 *      `ToolExecutor`) across all 7 tool categories and safety gates:
 *        - Capability probe gate (`/api/tools/capability`)
 *        - Calculator & unit conversion (`calculator_calculate`, `calculator_convert`)
 *        - Conversation file upload, `files_list`, `files_read`, `files_analyze`, and cleanup
 *        - Endpoint diagnostics (`diagnostics_check`)
 *        - Bounded 1-attempt corrective recovery (invalid arguments, invalid tool name,
 *          and raw `<tool_call>` markup in prose)
 *        - Python sandbox explicit approval & denial gate (`code_execute` is paused and
 *          denied by default; approved Docker execution runs only when `--run-docker-sandbox`
 *          is explicitly passed)
 *        - Configured HTTP GET tool and discovered/granted MCP Streamable HTTP tool
 *          against a local safe loopback fixture
 *
 * Security rules:
 *   - Credentials MUST be passed via environment variables (`KAGGLE_KIT_API_KEY` or
 *     `OPENAI_API_KEY`) or interactive `--prompt-key`. Passing `--api-key` on the
 *     command line is refused with exit code 2 so secrets never appear in `ps`.
 *   - API keys and secret values are redacted from all console output and JSON reports.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseCliArgs(argv) {
  for (const arg of argv) {
    if (
      arg === '--api-key'
      || arg.startsWith('--api-key=')
      || arg === '--key'
      || arg.startsWith('--key=')
      || arg === '--token'
      || arg.startsWith('--token=')
    ) {
      throw new Error(
        'Refusing to accept an API key on the command line (it would be visible in the process list). ' +
        'Set KAGGLE_KIT_API_KEY (or OPENAI_API_KEY) in the environment, or pass --prompt-key.',
      );
    }
  }

  const options = {
    mode: process.env.KAGGLE_KIT_BENCHMARK_MODE || 'both',
    baseUrl: process.env.KAGGLE_KIT_BASE_URL || process.env.OPENAI_BASE_URL || '',
    model: process.env.KAGGLE_KIT_MODEL || process.env.OPENAI_MODEL || '',
    trials: Number.parseInt(process.env.KAGGLE_KIT_BENCHMARK_TRIALS || '2', 10),
    timeoutMs: Number.parseInt(process.env.KAGGLE_KIT_TIMEOUT_MS || '45000', 10),
    spawnMock: false,
    promptKey: false,
    runDockerSandbox: false,
    jsonOnly: false,
    outputPath: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else if (flag === '--mode') {
      options.mode = argv[++i] || 'both';
    } else if (flag.startsWith('--mode=')) {
      options.mode = flag.slice('--mode='.length);
    } else if (flag === '--base-url') {
      options.baseUrl = argv[++i] || '';
    } else if (flag.startsWith('--base-url=')) {
      options.baseUrl = flag.slice('--base-url='.length);
    } else if (flag === '--model') {
      options.model = argv[++i] || '';
    } else if (flag.startsWith('--model=')) {
      options.model = flag.slice('--model='.length);
    } else if (flag === '--trials') {
      options.trials = Number.parseInt(argv[++i] || '2', 10);
    } else if (flag.startsWith('--trials=')) {
      options.trials = Number.parseInt(flag.slice('--trials='.length), 10);
    } else if (flag === '--timeout-ms') {
      options.timeoutMs = Number.parseInt(argv[++i] || '45000', 10);
    } else if (flag === '--spawn-mock') {
      options.spawnMock = true;
    } else if (flag === '--prompt-key') {
      options.promptKey = true;
    } else if (flag === '--run-docker-sandbox') {
      options.runDockerSandbox = true;
    } else if (flag === '--json') {
      options.jsonOnly = true;
    } else if (flag === '--output') {
      options.outputPath = argv[++i] || '';
    } else if (flag.startsWith('--output=')) {
      options.outputPath = flag.slice('--output='.length);
    } else {
      throw new Error(`Unknown option: ${flag}. Run with --help for usage.`);
    }
  }

  if (!['model', 'integration', 'both'].includes(options.mode)) {
    throw new Error(`--mode must be one of: model, integration, both (got "${options.mode}").`);
  }
  options.trials = Math.max(1, Math.min(10, Number.isFinite(options.trials) ? options.trials : 2));
  options.timeoutMs = Math.max(2_000, Math.min(300_000, Number.isFinite(options.timeoutMs) ? options.timeoutMs : 45_000));
  return options;
}

export function redactText(text, secrets = []) {
  let output = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.trim().length >= 4) {
      output = output.split(secret.trim()).join('[REDACTED_KEY]');
    }
  }
  output = output.replace(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g, 'https://[REDACTED_TUNNEL].trycloudflare.com');
  return output;
}

export function redactBaseUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.endsWith('.trycloudflare.com')
      ? '[REDACTED_TUNNEL].trycloudflare.com'
      : parsed.host;
    return `${parsed.protocol}//${host}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

async function promptSecret(promptText) {
  if (!process.stdin.isTTY) {
    throw new Error('--prompt-key requires an interactive TTY.');
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    process.stderr.write(promptText);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      process.stderr.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, headers: response.headers, text, json };
  } finally {
    clearTimeout(timer);
  }
}

const MODEL_ONLY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calculator_calculate',
      description: 'Evaluate a deterministic arithmetic expression.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'Arithmetic expression.' } },
        required: ['expression'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculator_convert',
      description: 'Convert a numeric value between units (km, mi, m, cm, kg, lb, c, f, k).',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number' },
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['value', 'from', 'to'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'files_list',
      description: 'List files uploaded to the current conversation.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diagnostics_check',
      description: 'Run read-only connectivity and capability diagnostics against the model endpoint.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

export async function runModelOnlyBenchmark({ baseUrl, apiKey, model, trials = 2, timeoutMs = 45_000 }) {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  let resolvedModel = model?.trim() || '';

  if (!resolvedModel) {
    const modelsRes = await fetchJson(`${normalizedBase}/models`, { headers: authHeaders, timeoutMs });
    if (!modelsRes.ok || !Array.isArray(modelsRes.json?.data) || !modelsRes.json.data[0]?.id) {
      throw new Error(`Model discovery failed at ${redactBaseUrl(normalizedBase)}/models (HTTP ${modelsRes.status}).`);
    }
    resolvedModel = modelsRes.json.data[0].id;
  }

  const scenarios = [
    {
      id: 'native_handshake',
      description: 'Two-step isolated native tool-call handshake (kaggle_kit_capability_probe) with synthetic no-op result.',
      runTrial: async () => {
        const probeTools = [{
          type: 'function',
          function: {
            name: 'kaggle_kit_capability_probe',
            description: 'Harmless capability check. Never executed.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        }];
        const probeMessages = [
          {
            role: 'system',
            content: 'This is an isolated no-op capability probe. Call kaggle_kit_capability_probe once with {}. After receiving the synthetic tool result, reply with KAGGLE_KIT_TOOL_PROBE_OK.',
          },
          {
            role: 'user',
            content: 'Call the function named kaggle_kit_capability_probe exactly once with an empty JSON object.',
          },
        ];
        const turn1 = await fetchJson(`${normalizedBase}/chat/completions`, {
          method: 'POST',
          headers: authHeaders,
          timeoutMs,
          body: {
            model: resolvedModel,
            messages: probeMessages,
            tools: probeTools,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            max_tokens: 192,
            temperature: 0,
            stream: false,
          },
        });
        const choice1 = turn1.json?.choices?.[0];
        const call = choice1?.message?.tool_calls?.[0];
        if (!turn1.ok || choice1?.finish_reason !== 'tool_calls' || call?.function?.name !== 'kaggle_kit_capability_probe') {
          return { passed: false, detail: `Turn 1 failed: finish_reason=${choice1?.finish_reason ?? 'none'}, tool=${call?.function?.name ?? 'none'}` };
        }
        let parsedArgs;
        try {
          parsedArgs = JSON.parse(call.function.arguments);
        } catch {
          return { passed: false, detail: 'Turn 1 tool arguments were not valid JSON.' };
        }
        if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs) || Object.keys(parsedArgs).length !== 0) {
          return { passed: false, detail: 'Turn 1 tool arguments were not an empty JSON object.' };
        }
        const turn2 = await fetchJson(`${normalizedBase}/chat/completions`, {
          method: 'POST',
          headers: authHeaders,
          timeoutMs,
          body: {
            model: resolvedModel,
            messages: [
              ...probeMessages,
              { role: 'assistant', content: null, tool_calls: [call] },
              { role: 'tool', tool_call_id: call.id, name: 'kaggle_kit_capability_probe', content: '{"ok":true,"synthetic":true,"result":"synthetic-no-op"}' },
            ],
            tools: probeTools,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            max_tokens: 192,
            temperature: 0,
            stream: false,
          },
        });
        const choice2 = turn2.json?.choices?.[0];
        const text2 = String(choice2?.message?.content ?? '').trim();
        const ok = turn2.ok && choice2?.finish_reason === 'stop' && /\bKAGGLE_KIT_TOOL_PROBE_OK\b/.test(text2);
        return {
          passed: ok,
          detail: ok
            ? 'Verified Turn 1 finish_reason=tool_calls and Turn 2 stop with KAGGLE_KIT_TOOL_PROBE_OK.'
            : `Turn 2 did not complete cleanly (finish_reason=${choice2?.finish_reason ?? 'none'}).`,
        };
      },
    },
    {
      id: 'streamed_tool_fragments',
      description: 'Streamed SSE tool-call fragment assembly (text/event-stream).',
      runTrial: async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${normalizedBase}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              ...authHeaders,
            },
            body: JSON.stringify({
              model: resolvedModel,
              messages: [{ role: 'user', content: 'calculate: 256 * 256' }],
              tools: MODEL_ONLY_TOOLS,
              tool_choice: 'auto',
              parallel_tool_calls: false,
              max_tokens: 192,
              temperature: 0,
              stream: true,
            }),
            signal: controller.signal,
          });
          const contentType = response.headers.get('content-type') || '';
          if (!response.ok || !contentType.toLowerCase().includes('text/event-stream')) {
            return { passed: false, detail: `HTTP ${response.status} content-type=${contentType || 'none'}` };
          }
          const rawSse = await response.text();
          let name = '';
          let args = '';
          let finishReason = '';
          for (const line of rawSse.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const deltaCall = choice?.delta?.tool_calls?.[0];
            if (deltaCall?.function?.name) name += deltaCall.function.name;
            if (deltaCall?.function?.arguments) args += deltaCall.function.arguments;
          }
          const parsedArgs = args ? JSON.parse(args) : null;
          const ok = finishReason === 'tool_calls'
            && name === 'calculator_calculate'
            && typeof parsedArgs?.expression === 'string'
            && parsedArgs.expression.includes('256');
          return {
            passed: ok,
            detail: ok
              ? `Assembled streamed call ${name}(${JSON.stringify(parsedArgs)}) with finish_reason=tool_calls.`
              : `Streamed assembly incomplete: name=${name || 'none'}, finish_reason=${finishReason || 'none'}.`,
          };
        } catch (error) {
          return { passed: false, detail: error instanceof Error ? error.message : String(error) };
        } finally {
          clearTimeout(timer);
        }
      },
    },
    {
      id: 'tool_selection_calculator',
      description: 'Selects calculator_calculate with valid expression schema and synthesizes a final answer from a labelled synthetic result.',
      runTrial: async () => {
        const messages = [
          { role: 'user', content: 'calculate: (144 / 12) + 30' },
        ];
        const turn1 = await fetchJson(`${normalizedBase}/chat/completions`, {
          method: 'POST',
          headers: authHeaders,
          timeoutMs,
          body: {
            model: resolvedModel,
            messages,
            tools: MODEL_ONLY_TOOLS,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            max_tokens: 192,
            temperature: 0,
            stream: false,
          },
        });
        const choice1 = turn1.json?.choices?.[0];
        const call = choice1?.message?.tool_calls?.[0];
        if (!turn1.ok || choice1?.finish_reason !== 'tool_calls' || call?.function?.name !== 'calculator_calculate') {
          return { passed: false, detail: `Expected calculator_calculate, got ${call?.function?.name ?? 'none'} (finish_reason=${choice1?.finish_reason ?? 'none'}).` };
        }
        const args = JSON.parse(call.function.arguments);
        if (typeof args?.expression !== 'string' || !args.expression.includes('144')) {
          return { passed: false, detail: `Invalid calculator arguments: ${call.function.arguments}` };
        }
        const syntheticPayload = JSON.stringify({
          ok: true,
          synthetic: true,
          note: 'Synthetic benchmark payload (no local calculator executed in model-only mode)',
          expression: args.expression,
          display: '42',
        });
        const turn2 = await fetchJson(`${normalizedBase}/chat/completions`, {
          method: 'POST',
          headers: authHeaders,
          timeoutMs,
          body: {
            model: resolvedModel,
            messages: [
              ...messages,
              { role: 'assistant', content: null, tool_calls: [call] },
              { role: 'tool', tool_call_id: call.id, name: 'calculator_calculate', content: syntheticPayload },
            ],
            tools: MODEL_ONLY_TOOLS,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            max_tokens: 192,
            temperature: 0,
            stream: false,
          },
        });
        const choice2 = turn2.json?.choices?.[0];
        const text2 = String(choice2?.message?.content ?? '');
        const ok = turn2.ok && choice2?.finish_reason === 'stop' && text2.includes('42');
        return {
          passed: ok,
          detail: ok
            ? 'Selected calculator_calculate with valid schema and synthesized final answer from labelled synthetic result.'
            : `Follow-up synthesis failed (finish_reason=${choice2?.finish_reason ?? 'none'}).`,
        };
      },
    },
    {
      id: 'tool_selection_unit_conversion',
      description: 'Selects calculator_convert with valid {value, from, to} schema.',
      runTrial: async () => {
        const turn1 = await fetchJson(`${normalizedBase}/chat/completions`, {
          method: 'POST',
          headers: authHeaders,
          timeoutMs,
          body: {
            model: resolvedModel,
            messages: [{ role: 'user', content: 'convert: 5 km to mi' }],
            tools: MODEL_ONLY_TOOLS,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            max_tokens: 192,
            temperature: 0,
            stream: false,
          },
        });
        const choice1 = turn1.json?.choices?.[0];
        const call = choice1?.message?.tool_calls?.[0];
        if (!turn1.ok || choice1?.finish_reason !== 'tool_calls' || call?.function?.name !== 'calculator_convert') {
          return { passed: false, detail: `Expected calculator_convert, got ${call?.function?.name ?? 'none'}.` };
        }
        const args = JSON.parse(call.function.arguments);
        const ok = typeof args?.value === 'number'
          && args.value === 5
          && typeof args?.from === 'string'
          && typeof args?.to === 'string';
        return {
          passed: ok,
          detail: ok
            ? `Selected calculator_convert(${JSON.stringify(args)}).`
            : `Invalid calculator_convert arguments: ${call.function.arguments}`,
        };
      },
    },
    {
      id: 'tool_selection_files_list',
      description: 'Selects files_list with empty object arguments when asked to list uploaded files.',
      runTrial: async () => {
        const turn1 = await fetchJson(`${normalizedBase}/chat/completions`, {
          method: 'POST',
          headers: authHeaders,
          timeoutMs,
          body: {
            model: resolvedModel,
            messages: [{ role: 'user', content: 'Please list uploaded files in this conversation.' }],
            tools: MODEL_ONLY_TOOLS,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            max_tokens: 192,
            temperature: 0,
            stream: false,
          },
        });
        const choice1 = turn1.json?.choices?.[0];
        const call = choice1?.message?.tool_calls?.[0];
        if (!turn1.ok || choice1?.finish_reason !== 'tool_calls' || call?.function?.name !== 'files_list') {
          return { passed: false, detail: `Expected files_list, got ${call?.function?.name ?? 'none'}.` };
        }
        const args = JSON.parse(call.function.arguments);
        const ok = Boolean(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0);
        return {
          passed: ok,
          detail: ok ? 'Selected files_list({}).' : `Unexpected files_list arguments: ${call.function.arguments}`,
        };
      },
    },
    {
      id: 'non_tool_restraint',
      description: 'Answers a plain greeting with finish_reason=stop without fabricating a tool call.',
      runTrial: async () => {
        const turn1 = await fetchJson(`${normalizedBase}/chat/completions`, {
          method: 'POST',
          headers: authHeaders,
          timeoutMs,
          body: {
            model: resolvedModel,
            messages: [{ role: 'user', content: 'Say hello in one short sentence without using any tool.' }],
            tools: MODEL_ONLY_TOOLS,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            max_tokens: 96,
            temperature: 0,
            stream: false,
          },
        });
        const choice1 = turn1.json?.choices?.[0];
        const calls = choice1?.message?.tool_calls ?? [];
        const ok = turn1.ok && choice1?.finish_reason === 'stop' && calls.length === 0 && Boolean(choice1?.message?.content);
        return {
          passed: ok,
          detail: ok
            ? 'Answered directly with finish_reason=stop and 0 tool calls.'
            : `Unexpected tool_calls=${calls.length} finish_reason=${choice1?.finish_reason ?? 'none'}.`,
        };
      },
    },
  ];

  const scenarioResults = [];
  for (const scenario of scenarios) {
    const samples = [];
    for (let index = 0; index < trials; index += 1) {
      try {
        const sample = await scenario.runTrial();
        samples.push({ trial: index + 1, ...sample });
      } catch (error) {
        samples.push({
          trial: index + 1,
          passed: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const passedCount = samples.filter((sample) => sample.passed).length;
    scenarioResults.push({
      id: scenario.id,
      description: scenario.description,
      trials,
      passedCount,
      failedCount: trials - passedCount,
      passRate: Number((passedCount / trials).toFixed(2)),
      passed: passedCount === trials,
      samples,
    });
  }

  const totalSamples = scenarioResults.reduce((sum, item) => sum + item.trials, 0);
  const passedSamples = scenarioResults.reduce((sum, item) => sum + item.passedCount, 0);

  return {
    phase: 'model_only',
    note: 'Tool results in model_only mode are explicitly labelled synthetic; real tool handlers are tested in application_integration mode.',
    endpoint: redactBaseUrl(normalizedBase),
    model: resolvedModel,
    trialsPerScenario: trials,
    totalScenarios: scenarioResults.length,
    passedScenarios: scenarioResults.filter((item) => item.passed).length,
    totalSamples,
    passedSamples,
    passRate: Number((passedSamples / Math.max(1, totalSamples)).toFixed(2)),
    scenarios: scenarioResults,
  };
}

async function startLocalFixtureServer() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url?.startsWith('/public-page')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Kaggle-Kit Benchmark Fixture</title></head><body><p>Deterministic public web fixture content.</p></body></html>');
        return;
      }
      if (req.url?.startsWith('/http-tool')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service: 'http-fixture', status: 'healthy', url: req.url }));
        return;
      }
      if (req.url === '/mcp' && req.method === 'POST') {
        const rpc = raw ? JSON.parse(raw) : {};
        if (rpc.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { protocolVersion: '2025-03-26', serverInfo: { name: 'benchmark-mcp-fixture', version: '1.0.0' }, capabilities: { tools: {} } },
          }));
          return;
        }
        if (rpc.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: [{
                name: 'ping',
                description: 'Read-only MCP fixture ping tool.',
                inputSchema: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                  required: ['query'],
                  additionalProperties: false,
                },
              }],
            },
          }));
          return;
        }
        if (rpc.method === 'tools/call') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [{ type: 'text', text: `MCP pong: ${rpc.params?.arguments?.query ?? ''}` }],
              isError: false,
            },
          }));
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function startLocalProxyServer(secretStoreFile) {
  const { createApp } = await import('../server/app.ts');
  const { loadServerConfig } = await import('../server/config.ts');
  const { createLogger } = await import('../server/logger.ts');

  const config = {
    ...loadServerConfig(
      {
        KAGGLE_KIT_ALLOW_PRIVATE_URLS: 'true',
        KAGGLE_KIT_SECRET_STORE_FILE: secretStoreFile,
      },
      ROOT,
    ),
    secretsFile: secretStoreFile,
    allowPrivateDestinations: true,
  };
  const logger = createLogger({ sink: () => undefined });
  const appServer = createApp({ config, logger });
  await new Promise((resolve) => appServer.server.listen(0, '127.0.0.1', resolve));
  const address = appServer.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => appServer.server.close(() => resolve())),
  };
}

export async function runApplicationIntegrationBenchmark({
  baseUrl,
  apiKey,
  model,
  timeoutMs = 45_000,
  runDockerSandbox = false,
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaggle-kit-bench-'));
  const secretFile = path.join(tempDir, 'secrets.json');
  const fixture = await startLocalFixtureServer();
  const proxy = await startLocalProxyServer(secretFile);
  const profileId = 'bench-profile';
  const conversationId = 'bench-conv';
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const checks = [];

  try {
    let resolvedModel = model?.trim() || '';
    if (!resolvedModel) {
      const modelsRes = await fetchJson(`${proxy.url}/api/proxy/models`, {
        method: 'POST',
        timeoutMs,
        body: { baseUrl: normalizedBase, ...(apiKey ? { apiKey } : {}) },
      });
      resolvedModel = modelsRes.json?.models?.[0] || 'mock-model';
    }

    // 1. Capability probe gate
    const probeRes = await fetchJson(`${proxy.url}/api/tools/capability`, {
      method: 'POST',
      timeoutMs,
      body: { baseUrl: normalizedBase, ...(apiKey ? { apiKey } : {}), model: resolvedModel, timeoutMs },
    });
    const probePassed = probeRes.ok && probeRes.json?.status === 'supported_verified';
    checks.push({
      id: 'capability_probe_gate',
      category: 'capability',
      passed: probePassed,
      detail: probeRes.json?.detail || `HTTP ${probeRes.status}`,
    });

    // Configure profile with built-in tools + safe HTTP GET fixture + MCP fixture
    const baseSettings = {
      enabled: true,
      allowedTools: [
        'calculator_calculate',
        'calculator_convert',
        'files_list',
        'files_read',
        'files_analyze',
        'web_open',
        'diagnostics_check',
        'code_execute',
        'http_bench_http',
        'mcp_bench_mcp_ping',
      ],
      historyPersistence: false,
      limits: {
        maxRounds: 4,
        maxCalls: 6,
        perToolTimeoutMs: 10_000,
        loopTimeoutMs: 45_000,
        maxOutputBytes: 12_000,
        maxInputBytes: 16_384,
      },
      web: { provider: 'none', storageRightsConfirmed: false },
      code: {
        provider: 'docker',
        image: `python:3.12-alpine@sha256:${'a'.repeat(64)}`,
        timeoutMs: 8_000,
        memoryMb: 256,
        cpuCores: 1,
        maxProcesses: 32,
        outputBytes: 8_192,
      },
      httpTools: [{
        id: 'bench_http',
        name: 'Benchmark HTTP Fixture',
        description: 'Write POST check that requires explicit user approval before execution.',
        endpoint: 'https://api.example.com/http-tool',
        method: 'POST',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        headers: [],
        permission: 'write',
        timeoutMs: 5_000,
      }],
      mcpServers: [{
        id: 'bench_mcp',
        name: 'Benchmark MCP Fixture',
        transport: 'streamable_http',
        enabled: true,
        confirmed: true,
        url: 'https://mcp.example.com/rpc',
        timeoutMs: 5_000,
        tools: [{
          serverToolName: 'ping',
          name: 'Ping',
          description: 'Write-gated MCP fixture tool.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
          selected: true,
          permission: 'write',
        }],
      }],
    };

    const saveRes = await fetchJson(`${proxy.url}/api/tools/profile`, {
      method: 'PUT',
      timeoutMs,
      body: { profileId, settings: baseSettings },
    });
    if (!saveRes.ok) {
      throw new Error(`Failed to save benchmark tool profile: HTTP ${saveRes.status} ${saveRes.text}`);
    }
    await fetchJson(`${proxy.url}/api/tools/mcp/grant`, {
      method: 'POST',
      timeoutMs,
      body: { profileId, serverId: 'bench_mcp' },
    });

    const runChat = async (userContent, conversationSettings) => fetchJson(`${proxy.url}/api/tools/chat`, {
      method: 'POST',
      timeoutMs,
      body: {
        profileId,
        conversationId,
        baseUrl: normalizedBase,
        ...(apiKey ? { apiKey } : {}),
        model: resolvedModel,
        messages: [{ role: 'user', content: userContent }],
        params: { maxTokens: 192, temperature: 0, topP: 1, stream: false },
        timeoutMs,
        ...(conversationSettings ? { conversationSettings } : {}),
      },
    });

    // 2. Calculator & unit conversion
    const calcRes = await runChat('calculate: (144 / 12) + 30', { toolIds: ['calculator_calculate'] });
    const calcTrace = calcRes.json?.toolTrace?.[0];
    const calcDiag = calcRes.json?.toolDiagnostics;
    checks.push({
      id: 'calculator_calculate_real',
      category: 'calculator',
      passed: Boolean(calcRes.ok && calcTrace?.toolName === 'calculator_calculate' && calcTrace?.status === 'succeeded' && calcTrace?.resultSummary?.includes('42')),
      outcome: calcDiag?.outcome,
      serializedToolBytes: calcDiag?.serializedToolBytes,
      detail: calcTrace?.resultSummary || calcRes.text,
    });

    const convRes = await runChat('convert: 5 km to mi', { toolIds: ['calculator_convert'] });
    const convTrace = convRes.json?.toolTrace?.[0];
    checks.push({
      id: 'calculator_convert_real',
      category: 'calculator',
      passed: Boolean(convRes.ok && convTrace?.toolName === 'calculator_convert' && convTrace?.status === 'succeeded' && convTrace?.resultSummary?.includes('mi')),
      outcome: convRes.json?.toolDiagnostics?.outcome,
      detail: convTrace?.resultSummary || convRes.text,
    });

    // 3. Uploaded files lifecycle (upload -> list -> read -> analyze -> cleanup)
    const uploadRes = await fetchJson(`${proxy.url}/api/tools/files/upload`, {
      method: 'POST',
      timeoutMs,
      body: {
        conversationId,
        name: 'benchmark-notes.md',
        mediaType: 'text/markdown',
        contentBase64: Buffer.from('# Benchmark Fixture\nAlpha=42\nBeta=99\n', 'utf8').toString('base64'),
      },
    });
    const uploadedFileId = uploadRes.json?.file?.id;
    const listFilesRes = await runChat('list uploaded files', { toolIds: ['files_list', 'files_read', 'files_analyze'] });
    const readFilesRes = uploadedFileId
      ? await runChat(`read file: ${uploadedFileId}`, { toolIds: ['files_list', 'files_read', 'files_analyze'] })
      : { ok: false, json: null };
    const analyzeFilesRes = uploadedFileId
      ? await runChat(`analyze file: ${uploadedFileId}`, { toolIds: ['files_list', 'files_read', 'files_analyze'] })
      : { ok: false, json: null };
    await fetchJson(`${proxy.url}/api/tools/files?conversationId=${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
      timeoutMs,
    });
    checks.push({
      id: 'uploaded_files_lifecycle',
      category: 'files',
      passed: Boolean(
        uploadRes.ok
        && listFilesRes.json?.toolTrace?.[0]?.status === 'succeeded'
        && readFilesRes.json?.toolTrace?.[0]?.status === 'succeeded'
        && analyzeFilesRes.json?.toolTrace?.[0]?.status === 'succeeded',
      ),
      outcome: readFilesRes.json?.toolDiagnostics?.outcome,
      detail: readFilesRes.json?.toolTrace?.[0]?.resultSummary || 'File upload/list/read/analyze check',
    });

    // 4. Public web SSRF guard (loopback/private URLs blocked by web_open)
    const webRes = await runChat('open url: http://127.0.0.1/private-admin', { toolIds: ['web_open'] });
    const webTrace = webRes.json?.toolTrace?.[0];
    checks.push({
      id: 'web_open_ssrf_guard',
      category: 'web',
      passed: Boolean(
        webRes.ok
        && webTrace?.toolName === 'web_open'
        && webTrace?.status === 'failed'
        && /private|loopback|reserved/i.test(webTrace?.error || ''),
      ),
      outcome: webRes.json?.toolDiagnostics?.outcome,
      detail: webTrace?.error || webRes.text,
    });

    // 5. Endpoint diagnostics
    const diagRes = await runChat('check diagnostics', { toolIds: ['diagnostics_check'] });
    const diagTrace = diagRes.json?.toolTrace?.[0];
    checks.push({
      id: 'diagnostics_check_real',
      category: 'diagnostics',
      passed: Boolean(diagRes.ok && diagTrace?.toolName === 'diagnostics_check' && diagTrace?.status === 'succeeded'),
      outcome: diagRes.json?.toolDiagnostics?.outcome,
      detail: diagTrace?.resultSummary || diagRes.text,
    });

    // 6. Configured HTTP write approval gate + MCP Streamable HTTP approval gate & SSRF guard
    const httpPendingRes = await runChat('call http: status', { toolIds: ['http_bench_http'] });
    const httpApproval = httpPendingRes.json?.pendingApproval;
    let httpGatePassed = false;
    if (httpPendingRes.ok && httpPendingRes.json?.status === 'awaiting_approval' && httpApproval?.approvalId) {
      const denyHttp = await fetchJson(`${proxy.url}/api/tools/approve`, {
        method: 'POST',
        timeoutMs,
        body: {
          jobId: httpPendingRes.json.jobId,
          approvalId: httpApproval.approvalId,
          approved: false,
        },
      });
      httpGatePassed = Boolean(denyHttp.ok && denyHttp.json?.toolTrace?.[0]?.status === 'denied');
    }

    const mcpPendingRes = await runChat('call mcp: ping-test', { toolIds: ['mcp_bench_mcp_ping'] });
    const mcpApproval = mcpPendingRes.json?.pendingApproval;
    let mcpGatePassed = false;
    if (mcpPendingRes.ok && mcpPendingRes.json?.status === 'awaiting_approval' && mcpApproval?.approvalId) {
      const denyMcp = await fetchJson(`${proxy.url}/api/tools/approve`, {
        method: 'POST',
        timeoutMs,
        body: {
          jobId: mcpPendingRes.json.jobId,
          approvalId: mcpApproval.approvalId,
          approved: false,
        },
      });
      mcpGatePassed = Boolean(denyMcp.ok && denyMcp.json?.toolTrace?.[0]?.status === 'denied');
    }

    const { discoverMcpTools } = await import('../server/tools/mcp.ts');
    let mcpSsrfBlocked = false;
    try {
      await discoverMcpTools({
        id: 'bench_mcp',
        name: 'Benchmark MCP Fixture',
        transport: 'streamable_http',
        enabled: true,
        confirmed: true,
        url: 'https://mcp.example.com/rpc',
        timeoutMs: 2_000,
        tools: [],
      }, {
        headers: {},
        timeoutMs: 2_000,
        lookup: async () => [{ address: '10.0.0.8', family: 4 }],
      });
    } catch (error) {
      mcpSsrfBlocked = /private|non-public/i.test(error instanceof Error ? error.message : String(error));
    }

    checks.push({
      id: 'http_and_mcp_safe_fixtures',
      category: 'http_mcp',
      passed: Boolean(httpGatePassed && mcpGatePassed && mcpSsrfBlocked),
      detail: `HTTP approval gate=${httpGatePassed}, MCP approval gate=${mcpGatePassed}, MCP SSRF guard=${mcpSsrfBlocked}`,
    });

    // 7. Python sandbox explicit approval & denial gate
    const codePendingRes = await runChat('run code: print(6 * 7)', { toolIds: ['code_execute'] });
    const pendingApproval = codePendingRes.json?.pendingApproval;
    const pausedForApproval = codePendingRes.ok
      && codePendingRes.json?.status === 'awaiting_approval'
      && Boolean(pendingApproval?.approvalId && codePendingRes.json?.jobId);
    let denialPassed = false;
    if (pausedForApproval) {
      const denyRes = await fetchJson(`${proxy.url}/api/tools/approve`, {
        method: 'POST',
        timeoutMs,
        body: {
          jobId: codePendingRes.json.jobId,
          approvalId: pendingApproval.approvalId,
          approved: false,
        },
      });
      const deniedTrace = denyRes.json?.toolTrace?.[0];
      denialPassed = Boolean(
        denyRes.ok
        && denyRes.json?.status === 'complete'
        && deniedTrace?.status === 'denied'
        && deniedTrace?.approvalState === 'denied'
        && denyRes.json?.toolDiagnostics?.outcome === 'approval_denied',
      );
    }
    checks.push({
      id: 'python_sandbox_approval_and_denial_gate',
      category: 'code_execute',
      passed: Boolean(pausedForApproval && denialPassed),
      detail: pausedForApproval && denialPassed
        ? 'Verified code_execute pauses in awaiting_approval without running and honours explicit user denial.'
        : 'Approval/denial gate check did not complete as expected.',
    });

    if (runDockerSandbox) {
      const approvePending = await runChat('run code: print(6 * 7)', { toolIds: ['code_execute'] });
      const approval = approvePending.json?.pendingApproval;
      const approveRes = approval
        ? await fetchJson(`${proxy.url}/api/tools/approve`, {
          method: 'POST',
          timeoutMs,
          body: {
            jobId: approvePending.json.jobId,
            approvalId: approval.approvalId,
            approved: true,
          },
        })
        : { ok: false, json: null };
      const approveTrace = approveRes.json?.toolTrace?.[0];
      checks.push({
        id: 'python_sandbox_approved_docker_run',
        category: 'code_execute',
        passed: Boolean(approveRes.ok && approveTrace?.status === 'succeeded'),
        detail: approveTrace?.resultSummary || approveTrace?.error || 'Docker sandbox check',
      });
    }

    // 8. Bounded 1-attempt corrective recovery checks (invalid arguments, invalid tool name, raw markup)
    const badArgsRes = await runChat('corrective-bad-args: 21 * 2', { toolIds: ['calculator_calculate'] });
    const badArgsDiag = badArgsRes.json?.toolDiagnostics;
    checks.push({
      id: 'corrective_recovery_invalid_arguments',
      category: 'corrective_recovery',
      passed: Boolean(
        badArgsRes.ok
        && badArgsDiag?.outcome === 'corrected_after_retry'
        && badArgsDiag?.correctiveAttemptsUsed === 1
        && badArgsDiag?.correctionOutcome === 'recovered'
        && badArgsRes.json?.toolTrace?.length === 2
        && badArgsRes.json?.toolTrace?.[0]?.status === 'failed'
        && badArgsRes.json?.toolTrace?.[1]?.status === 'succeeded',
      ),
      outcome: badArgsDiag?.outcome,
      detail: `correctiveAttemptsUsed=${badArgsDiag?.correctiveAttemptsUsed ?? 0}, correctionOutcome=${badArgsDiag?.correctionOutcome ?? 'none'}`,
    });

    const badToolRes = await runChat('corrective-bad-tool: 19 + 23', { toolIds: ['calculator_calculate'] });
    const badToolDiag = badToolRes.json?.toolDiagnostics;
    checks.push({
      id: 'corrective_recovery_invalid_tool_name',
      category: 'corrective_recovery',
      passed: Boolean(
        badToolRes.ok
        && badToolDiag?.outcome === 'corrected_after_retry'
        && badToolDiag?.correctiveAttemptsUsed === 1
        && badToolDiag?.correctionOutcome === 'recovered',
      ),
      outcome: badToolDiag?.outcome,
      detail: `correctiveAttemptsUsed=${badToolDiag?.correctiveAttemptsUsed ?? 0}, correctionOutcome=${badToolDiag?.correctionOutcome ?? 'none'}`,
    });

    const rawMarkupRes = await runChat('corrective-raw-markup: 6 * 7', { toolIds: ['calculator_calculate'] });
    const rawMarkupDiag = rawMarkupRes.json?.toolDiagnostics;
    checks.push({
      id: 'corrective_recovery_raw_tool_markup',
      category: 'corrective_recovery',
      passed: Boolean(
        rawMarkupRes.ok
        && rawMarkupDiag?.outcome === 'corrected_after_retry'
        && rawMarkupDiag?.correctiveAttemptsUsed === 1
        && rawMarkupDiag?.correctionOutcome === 'recovered'
        && rawMarkupRes.json?.toolTrace?.[0]?.status === 'succeeded',
      ),
      outcome: rawMarkupDiag?.outcome,
      detail: `correctiveAttemptsUsed=${rawMarkupDiag?.correctiveAttemptsUsed ?? 0}, correctionReason=${rawMarkupDiag?.correctionReason ?? 'none'}`,
    });

    const passedChecks = checks.filter((item) => item.passed).length;
    return {
      phase: 'application_integration',
      endpoint: redactBaseUrl(normalizedBase),
      model: resolvedModel,
      totalChecks: checks.length,
      passedChecks,
      failedChecks: checks.length - passedChecks,
      passRate: Number((passedChecks / Math.max(1, checks.length)).toFixed(2)),
      checks,
    };
  } finally {
    await proxy.close();
    await fixture.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function startEphemeralMockUpstream(apiKey = 'bench-mock-key') {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'tools/mock-upstream.mjs'), '--port', '0', '--api-key', apiKey],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Wait for port announcement or pick a free port if mock-upstream needs an explicit port
  child.kill('SIGTERM');
  const probeServer = http.createServer();
  await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
  const addr = probeServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 18991;
  await new Promise((resolve) => probeServer.close(() => resolve()));

  const mock = spawn(
    process.execPath,
    [path.join(ROOT, 'tools/mock-upstream.mjs'), '--port', String(port), '--api-key', apiKey],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mock upstream did not start in time.')), 10_000);
    mock.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Mock upstream listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    mock.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Mock upstream exited early with code ${code}`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey,
    close: () => {
      mock.kill('SIGTERM');
    },
  };
}

function printUsage() {
  console.log(`Usage:
  KAGGLE_KIT_BASE_URL=https://<tunnel>.trycloudflare.com/v1 \\
  KAGGLE_KIT_API_KEY=<key> \\
  node --import tsx tools/benchmark-tool-calling.mjs [options]

  # Or run against the deterministic local mock upstream + real proxy handlers:
  node --import tsx tools/benchmark-tool-calling.mjs --spawn-mock

Options:
  --mode <model|integration|both>  Benchmark phase(s) to run (default: both)
  --base-url <url>                 OpenAI-compatible /v1 base URL (or set KAGGLE_KIT_BASE_URL)
  --model <id>                     Model ID (default: auto-discover first model from /models)
  --trials <n>                     Trials per scenario in model-only mode (default: 2)
  --timeout-ms <ms>                Per-request timeout in ms (default: 45000)
  --prompt-key                     Read the API key interactively with echo disabled
  --spawn-mock                     Start tools/mock-upstream.mjs on an ephemeral loopback port
  --run-docker-sandbox             Also execute an approved Docker sandbox run in integration mode
  --json                           Print JSON report only
  --output <path>                  Write redacted JSON report to file
  --help, -h                       Show this help text

Security:
  Never pass --api-key on the command line (rejected with exit code 2).`);
}

async function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[benchmark] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  if (options.help) {
    printUsage();
    return;
  }

  let apiKey = process.env.KAGGLE_KIT_API_KEY || process.env.OPENAI_API_KEY || '';
  if (options.promptKey && !apiKey) {
    apiKey = await promptSecret('Enter endpoint API key (input hidden): ');
  }

  let mockHandle = null;
  let baseUrl = options.baseUrl;
  let endpointType = 'live_upstream';

  if (options.spawnMock) {
    mockHandle = await startEphemeralMockUpstream(apiKey || 'bench-mock-key');
    baseUrl = mockHandle.baseUrl;
    apiKey = mockHandle.apiKey;
    endpointType = 'mock_upstream';
  }

  if (!baseUrl) {
    console.error(
      '[benchmark] ERROR: No endpoint configured. Set KAGGLE_KIT_BASE_URL (and KAGGLE_KIT_API_KEY) for a live model endpoint, or pass --spawn-mock for the local deterministic harness.',
    );
    process.exit(2);
  }

  const secretsToRedact = [apiKey].filter(Boolean);

  try {
    const report = {
      generatedAt: new Date().toISOString(),
      endpointType,
      endpoint: redactBaseUrl(baseUrl),
      mode: options.mode,
      whatThisProves: endpointType === 'live_upstream'
        ? [
          'Live model native tool-call protocol and round-trip completion on the configured endpoint.',
          'Real tool selection, argument schema adherence, and corrective recovery across the executed phases.',
        ]
        : [
          'End-to-end Kaggle-Kit tool-calling wire protocol, capability gating, schema validation, bounded 1-attempt corrective recovery, and handler execution against the deterministic mock upstream.',
          'Does NOT prove live Qwen3.8-27B GPU inference quality until re-run against a live Kaggle/llama-server endpoint without --spawn-mock.',
        ],
      phases: {},
    };

    if (options.mode === 'model' || options.mode === 'both') {
      report.phases.modelOnly = await runModelOnlyBenchmark({
        baseUrl,
        apiKey,
        model: options.model,
        trials: options.trials,
        timeoutMs: options.timeoutMs,
      });
    }

    if (options.mode === 'integration' || options.mode === 'both') {
      report.phases.applicationIntegration = await runApplicationIntegrationBenchmark({
        baseUrl,
        apiKey,
        model: options.model,
        timeoutMs: options.timeoutMs,
        runDockerSandbox: options.runDockerSandbox,
      });
    }

    const serialized = redactText(JSON.stringify(report, null, 2), secretsToRedact);
    if (options.outputPath) {
      await fs.writeFile(options.outputPath, `${serialized}\n`, 'utf8');
    }

    if (options.jsonOnly) {
      console.log(serialized);
    } else {
      console.log('============================================================');
      console.log(`KAGGLE-KIT TOOL-CALLING BENCHMARK (${endpointType.toUpperCase()})`);
      console.log('============================================================');
      console.log(`Endpoint: ${report.endpoint}`);
      if (report.phases.modelOnly) {
        const phase = report.phases.modelOnly;
        console.log(`\n[Phase 1: Model-Only Mode] (${phase.passedScenarios}/${phase.totalScenarios} scenarios, ${phase.passedSamples}/${phase.totalSamples} trial samples passed)`);
        for (const scenario of phase.scenarios) {
          console.log(`  - ${scenario.passed ? 'PASS' : 'FAIL'} ${scenario.id} (${scenario.passedCount}/${scenario.trials}): ${redactText(scenario.samples.at(-1)?.detail || '', secretsToRedact)}`);
        }
      }
      if (report.phases.applicationIntegration) {
        const phase = report.phases.applicationIntegration;
        console.log(`\n[Phase 2: Application Integration Mode] (${phase.passedChecks}/${phase.totalChecks} checks passed)`);
        for (const check of phase.checks) {
          console.log(`  - ${check.passed ? 'PASS' : 'FAIL'} [${check.category}] ${check.id}: ${redactText(check.detail || '', secretsToRedact)}`);
        }
      }
      console.log('============================================================');
    }

    const modelFailed = report.phases.modelOnly && report.phases.modelOnly.passedScenarios < report.phases.modelOnly.totalScenarios;
    const integrationFailed = report.phases.applicationIntegration && report.phases.applicationIntegration.passedChecks < report.phases.applicationIntegration.totalChecks;
    if (modelFailed || integrationFailed) {
      process.exitCode = 1;
    }
  } finally {
    mockHandle?.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[benchmark] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
