/**
 * Pure logic of the live-model tool-calling benchmark (no I/O, no network).
 *
 * The CLI in `model-benchmark.mjs` performs the requests; everything that can
 * be unit tested lives here: argument parsing (which must reject secrets on
 * the command line), endpoint-identity sanitization, the deterministic
 * expression evaluator used for semantic argument checks, outcome
 * classification, scoring and the secret-free report shape.
 *
 * Vocabulary used across the benchmark:
 *  - passed   the case produced the expected evidence
 *  - failed   the case ran but the evidence contradicts the expectation
 *  - blocked  a precondition failed (endpoint rejected the tool protocol,
 *             HTTP 4xx on the tools parameter): the behaviour is unknown
 *  - skipped  the case was not attempted (missing configuration/service);
 *             a skipped case is never counted as passed
 *
 * Layers, kept strictly apart (a weaker layer never implies a stronger one):
 *  protocol   the native tool-call wire protocol works
 *  selection  the model picks the right tool for an unambiguous task
 *  arguments  the call arguments match the schema and the expected semantics
 *  execution  a real Kaggle-Kit executor ran (integration mode only; model
 *             mode uses synthetic results and says so)
 *  end_to_end a complete user task succeeded through the real tool loop
 */

export const BENCHMARK_NAME = 'kaggle-kit-model-benchmark';
export const BENCHMARK_VERSION = '1.0.0';

/** The synthetic marker that must appear in every synthetic tool result. */
export const SYNTHETIC_MARKER = 'synthetic-benchmark-result';

/** The tool list offered in the selection cases: one unambiguous target plus
 * one plausible distractor, so "selected the calculator" is a real signal. */
export const BENCHMARK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calculator_calculate',
      description: 'Evaluate a deterministic arithmetic expression. Supported: +, -, *, /, %, ^, parentheses and decimal numbers.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', minLength: 1, maxLength: 512 } },
        required: ['expression'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web. Returns result URLs and metadata.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 2, maxLength: 400 } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

export const SELECTION_TASK = {
  id: 'selection_and_arguments',
  // Phrased so the deterministic mock upstream (tools/mock-upstream.mjs) can
  // answer it too: its scripted calculator call keys on "calculate: <expr>"
  // at the end of the prompt. Real models see one unambiguous instruction.
  prompt: 'Use the calculator_calculate tool to solve this, then give me the final number. calculate: 17 * 23 + 101',
  expectedTool: 'calculator_calculate',
  expectedValue: 492,
};

export const NEGATIVE_TASK = {
  id: 'negative_selection',
  prompt: 'Answer in one short sentence: what is the capital city of France? Do not use any tools.',
};

export const HANDSHAKE_TOOL = {
  type: 'function',
  function: {
    name: 'kaggle_kit_capability_probe',
    description: 'Harmless capability check. It has no side effects and must never be executed.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

export const HANDSHAKE_OK_TEXT = 'KAGGLE_KIT_TOOL_PROBE_OK';

export const USAGE = `kaggle-kit live-model tool-calling benchmark

Usage:
  node tools/model-benchmark.mjs --base-url <url> --model <id> [options]

Options:
  --mode model|integration   model = direct endpoint tests (default);
                             integration = through a running Kaggle-Kit proxy
  --base-url <url>           OpenAI-compatible base URL (env OPENAI_BASE_URL
                             or KAGGLE_KIT_MODEL_URL)
  --model <id>               model ID (env OPENAI_MODEL or KAGGLE_KIT_MODEL_ID)
  --trials <n>               repetitions per model case, default 3
  --timeout <ms>             per-request timeout, default 60000
  --report <file>            also write the JSON report to <file>
  --origin <url>             integration mode: proxy origin, default
                             http://127.0.0.1:8787 (env KAGGLE_KIT_ORIGIN)
  --profile-id <id>          integration mode: server-side tool profile ID
  --conversation-id <id>     integration mode: conversation ID (fresh recommended)
  --include-streaming        also verify streamed tool-call fragments
  --no-prompt                never ask interactively for a missing API key

Credentials:
  The API key is read from OPENAI_API_KEY or KAGGLE_KIT_MODEL_API_KEY, or
  asked for on an interactive, masked prompt. Command-line secrets are
  rejected: --api-key is not a valid option. An empty key is allowed for
  local servers that do not require authentication.

What this proves: see docs/troubleshooting.md ("Live-model benchmark").
Model mode verifies the tool protocol, tool selection and argument
correctness against synthetic results only; it never executes a real tool.
`;

/**
 * Parse CLI arguments. Rejects any attempt to pass a secret as an argument:
 * command lines are visible in process listings and shell history.
 */
export function parseBenchmarkArgs(argv) {
  const options = {
    mode: 'model',
    baseUrl: '',
    model: '',
    trials: 3,
    timeoutMs: 60_000,
    reportPath: '',
    origin: 'http://127.0.0.1:8787',
    profileId: '',
    conversationId: '',
    includeStreaming: false,
    prompt: true,
  };
  const errors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] ?? '';
    switch (arg) {
      case '--api-key': case '--apikey': case '--key': case '--token': case '--authorization':
        errors.push('API keys must never be passed as command-line arguments; use OPENAI_API_KEY/KAGGLE_KIT_MODEL_API_KEY or the interactive prompt.');
        break;
      case '--mode': options.mode = next(); break;
      case '--base-url': options.baseUrl = next(); break;
      case '--model': options.model = next(); break;
      case '--trials': options.trials = Number.parseInt(next(), 10); break;
      case '--timeout': options.timeoutMs = Number.parseInt(next(), 10); break;
      case '--report': options.reportPath = next(); break;
      case '--origin': options.origin = next(); break;
      case '--profile-id': options.profileId = next(); break;
      case '--conversation-id': options.conversationId = next(); break;
      case '--include-streaming': options.includeStreaming = true; break;
      case '--no-prompt': options.prompt = false; break;
      case '--help': case '-h': options.help = true; break;
      default: errors.push(`Unknown argument: ${arg}`);
    }
  }
  if (!['model', 'integration'].includes(options.mode)) errors.push(`Unknown mode: ${options.mode}`);
  if (!Number.isFinite(options.trials) || options.trials < 1 || options.trials > 20) errors.push('--trials must be an integer between 1 and 20.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 600_000) errors.push('--timeout must be between 1000 and 600000 ms.');
  if (!options.help && !options.baseUrl) errors.push('A --base-url (or OPENAI_BASE_URL / KAGGLE_KIT_MODEL_URL) is required.');
  if (!options.help && !options.model) errors.push('A --model (or OPENAI_MODEL / KAGGLE_KIT_MODEL_ID) is required.');
  return { options, errors };
}

/**
 * A reportable endpoint identity: scheme, host and path only. Credentials,
 * query strings and fragments are stripped before anything is recorded.
 */
export function sanitizeEndpointIdentity(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

/** How a credential may appear in output: never by value, only by length. */
export function redactSecretDisplay(value) {
  if (typeof value !== 'string' || value.length === 0) return '(no API key configured)';
  return `[redacted API key, length ${value.length}]`;
}

/**
 * Deterministic arithmetic evaluator for the semantic argument check.
 * Grammar: + - * / % ^ ( ) and non-negative decimal numbers. It exists so
 * the benchmark never uses eval/Function on model-produced text.
 */
export function evaluateExpression(input) {
  const text = String(input).replace(/\s+/g, '');
  if (!/^[0-9.+\-*/%^()]+$/.test(text)) throw new Error('Expression contains unsupported characters.');
  let position = 0;

  const peek = () => text[position];
  const parseNumber = () => {
    const start = position;
    if (peek() === '-') position += 1;
    while (position < text.length && /[0-9.]/.test(text[position])) position += 1;
    if (start === position) throw new Error('Expected a number.');
    const value = Number(text.slice(start, position));
    if (!Number.isFinite(value)) throw new Error('Expression overflowed to a non-finite number.');
    return value;
  };
  const parsePrimary = () => {
    if (peek() === '(') {
      position += 1;
      const value = parseExpression();
      if (peek() !== ')') throw new Error('Missing closing parenthesis.');
      position += 1;
      return value;
    }
    return parseNumber();
  };
  const parsePower = () => {
    const base = parsePrimary();
    if (peek() === '^') { position += 1; return base ** parsePower(); }
    return base;
  };
  const parseTerm = () => {
    let value = parsePower();
    for (;;) {
      const operator = peek();
      if (operator === '*') { position += 1; value *= parsePower(); }
      else if (operator === '/') { position += 1; value /= parsePower(); }
      else if (operator === '%') { position += 1; value %= parsePower(); }
      else return value;
    }
  };
  const parseSum = () => {
    let value = parseTerm();
    for (;;) {
      const operator = peek();
      if (operator === '+') { position += 1; value += parseTerm(); }
      else if (operator === '-') { position += 1; value -= parseTerm(); }
      else return value;
    }
  };
  const parseExpression = () => parseSum();

  const result = parseExpression();
  if (position !== text.length) throw new Error('Unexpected trailing input.');
  if (!Number.isFinite(result)) throw new Error('Expression produced a non-finite number.');
  return result;
}

/** HTTP statuses that mean "this endpoint does not speak the tool protocol". */
export function isProtocolRejection(status) {
  return status === 400 || status === 404 || status === 422;
}

export function makeResult(caseId, trial, outcome, layer, reason, evidence) {
  return {
    caseId,
    trial,
    outcome,
    layer,
    reason,
    ...(evidence === undefined ? {} : { evidence }),
  };
}

/**
 * Check one completion against the selection+arguments expectation.
 * Returns per-layer verdicts so the report can separate "protocol works but
 * the model chose the wrong tool" from "the endpoint has no tool protocol".
 */
export function checkSelectionAndArguments(completion) {
  const details = [];
  const choice = Array.isArray(completion?.choices) && completion.choices.length === 1 ? completion.choices[0] : undefined;
  if (!choice) return { protocolOk: false, selectionOk: false, argumentsOk: false, details: ['The completion did not contain exactly one choice.'], call: undefined, value: undefined };
  const finishOk = choice.finish_reason === 'tool_calls';
  if (!finishOk) details.push(`finish_reason was "${choice.finish_reason ?? 'missing'}", expected "tool_calls".`);
  const calls = choice.message?.tool_calls;
  const call = Array.isArray(calls) && calls.length >= 1 ? calls[0] : undefined;
  if (!Array.isArray(calls) || calls.length === 0) {
    details.push('The completion contained no tool_calls; the model answered with plain text instead.');
    return { protocolOk: finishOk, selectionOk: false, argumentsOk: false, details, call: undefined, value: undefined };
  }
  if (calls.length > 1) details.push(`The model returned ${calls.length} calls; only the first was evaluated (parallel_tool_calls=false was requested).`);
  const protocolOk = finishOk && call?.type === 'function' && typeof call.id === 'string' && call.id.length > 0 && typeof call.function?.arguments === 'string';
  if (!protocolOk && details.length === 0) details.push('The tool-call payload did not match the OpenAI tool-call shape.');
  const selectionOk = call?.function?.name === SELECTION_TASK.expectedTool;
  if (!selectionOk) details.push(`The model called "${call?.function?.name ?? 'nothing'}" instead of "${SELECTION_TASK.expectedTool}".`);
  let argumentsOk = false;
  let value;
  if (selectionOk && protocolOk) {
    try {
      const args = JSON.parse(call.function.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) details.push('The arguments were not a JSON object.');
      else if (Object.keys(args).some((key) => key !== 'expression')) details.push(`The arguments contained keys outside the schema: ${Object.keys(args).filter((key) => key !== 'expression').join(', ')}.`);
      else if (typeof args.expression !== 'string') details.push('The expression argument was not a string.');
      else {
        const computed = evaluateExpression(args.expression);
        value = computed;
        if (Math.abs(computed - SELECTION_TASK.expectedValue) < 1e-6) argumentsOk = true;
        else details.push(`The expression "${args.expression}" evaluates to ${computed}, expected ${SELECTION_TASK.expectedValue}.`);
      }
    } catch (error) {
      details.push(`The arguments were not schema-valid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { protocolOk, selectionOk, argumentsOk, details, call, value };
}

/** Check that a plain question did not trigger a tool call. */
export function checkNoToolUse(completion) {
  const choice = Array.isArray(completion?.choices) && completion.choices.length >= 1 ? completion.choices[0] : undefined;
  const calls = choice?.message?.tool_calls;
  const hadCalls = Array.isArray(calls) && calls.length > 0;
  const content = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
  const details = [];
  if (hadCalls) details.push(`The model called "${calls[0]?.function?.name}" for a question that needs no tool.`);
  if (!content) details.push('The completion contained no answer text.');
  return { ok: !hadCalls && content.length > 0, details };
}

/**
 * Check the synthetic follow-up: after a clearly-marked synthetic tool
 * result, the model must produce a final answer, must not call again, and
 * must not claim that a real action was performed.
 */
export function checkSyntheticFollowUp(completion, expectedValue) {
  const details = [];
  const choice = Array.isArray(completion?.choices) && completion.choices.length === 1 ? completion.choices[0] : undefined;
  if (!choice) return { ok: false, details: ['The follow-up completion did not contain exactly one choice.'] };
  const finishOk = choice.finish_reason === 'stop';
  if (!finishOk) details.push(`finish_reason was "${choice.finish_reason ?? 'missing'}", expected "stop".`);
  const calls = choice.message?.tool_calls;
  if (Array.isArray(calls) && calls.length > 0) details.push('The model issued another tool call after receiving the synthetic result.');
  const content = typeof choice.message?.content === 'string' ? choice.message.content : '';
  if (!content.trim()) details.push('The final answer was empty.');
  if (expectedValue !== undefined && content.length > 0 && !content.includes(String(expectedValue))) {
    details.push(`The final answer does not mention the synthetic result value ${expectedValue}.`);
  }
  return { ok: finishOk && details.length === 0, details };
}

/** Per-case scores across trials; counts never merge skipped into passed. */
export function summarizeResults(results) {
  const totals = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  const perCase = new Map();
  for (const result of results) {
    totals[result.outcome] = (totals[result.outcome] ?? 0) + 1;
    const entry = perCase.get(result.caseId) ?? { caseId: result.caseId, layer: result.layer, passed: 0, failed: 0, blocked: 0, skipped: 0, trials: 0, reasons: [] };
    entry[result.outcome] += 1;
    entry.trials += 1;
    if (result.outcome !== 'passed' && result.reason && !entry.reasons.includes(result.reason)) entry.reasons.push(result.reason);
    perCase.set(result.caseId, entry);
  }
  const cases = [...perCase.values()].map((entry) => ({
    ...entry,
    score: entry.trials - entry.skipped - entry.blocked > 0
      ? `${entry.passed}/${entry.trials - entry.skipped - entry.blocked} attempted trial(s) passed`
      : 'no attempted trials (all blocked or skipped)',
  }));
  return { totals, cases };
}

/**
 * Collapse case outcomes into the five evidence layers. A layer is only
 * "verified" when at least one case in it passed and none failed.
 */
export function layerSummary(results) {
  const layers = { protocol: 'not_proven', selection: 'not_proven', arguments: 'not_proven', execution: 'not_proven', end_to_end: 'not_proven' };
  const byLayer = (layer) => results.filter((result) => result.layer === layer);
  for (const layer of Object.keys(layers)) {
    const entries = byLayer(layer);
    if (entries.length === 0) continue;
    if (entries.some((entry) => entry.outcome === 'failed')) layers[layer] = 'failed';
    else if (entries.some((entry) => entry.outcome === 'passed')) layers[layer] = 'verified';
    else if (entries.every((entry) => entry.outcome === 'skipped')) layers[layer] = 'skipped';
    else layers[layer] = 'blocked';
  }
  return layers;
}

/** The sanitized report document. Never contains a credential value. */
export function buildReport(input) {
  const summary = summarizeResults(input.results);
  return {
    benchmark: BENCHMARK_NAME,
    benchmarkVersion: BENCHMARK_VERSION,
    mode: input.mode,
    generatedAt: input.finishedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    model: input.model,
    endpoint: sanitizeEndpointIdentity(input.baseUrl),
    credential: redactSecretDisplay(input.apiKey),
    requestSettings: input.requestSettings,
    trials: input.trials,
    results: input.results,
    summary,
    layers: layerSummary(input.results),
    interpretation: input.mode === 'model'
      ? 'Model mode verifies the tool protocol, tool selection and argument correctness against SYNTHETIC tool results. It does not prove that any Kaggle-Kit executor ran, and a passed selection case is not statistical significance: check the trial counts.'
      : 'Integration mode exercised a running Kaggle-Kit proxy. Cases whose preconditions were missing are reported as skipped, never as passed. Code execution was never approved automatically.',
  };
}

/**
 * Defence in depth: refuse to emit a report that contains any of the secret
 * values the run knew about. Returns the list of violations (empty = safe).
 */
export function findSecretLeaks(report, secrets) {
  const serialized = JSON.stringify(report);
  return (secrets ?? []).filter((secret) => typeof secret === 'string' && secret.length >= 8 && serialized.includes(secret));
}

/** Minimal SSE tool-call fragment assembly for the streaming probe. */
export function createToolCallAccumulator() {
  const calls = new Map();
  return {
    add(delta) {
      for (const fragment of delta?.choices?.[0]?.delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const entry = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof fragment.id === 'string') entry.id = fragment.id;
        if (typeof fragment.function?.name === 'string') entry.name += fragment.function.name;
        if (typeof fragment.function?.arguments === 'string') entry.arguments += fragment.function.arguments;
        if (entry.arguments.length > 4_096) throw new Error('Streamed tool-call arguments exceeded the accumulator bound.');
        calls.set(index, entry);
      }
      return delta?.choices?.[0]?.finish_reason ?? delta?.choices?.[0]?.delta?.finish_reason ?? undefined;
    },
    finish() {
      return [...calls.values()];
    },
  };
}
