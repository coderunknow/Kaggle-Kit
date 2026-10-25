#!/usr/bin/env node
/**
 * A tiny OpenAI-compatible server for local development and manual testing.
 *
 * It behaves like llama.cpp's server: it serves /v1/models, /v1/chat/completions
 * (streaming and non streaming), /health and /props. Use it to try the chat
 * interface without a GPU.
 *
 *   node tools/mock-upstream.mjs --port 8000 --api-key demo-key
 *
 * Deterministic tool behaviour for integration checks: when a request carries
 * tools, the mock answers with a native tool call instead of prose.
 *
 *   - the harmless `kaggle_kit_capability_probe` function -> `{}` call, and
 *     the exact `KAGGLE_KIT_TOOL_PROBE_OK` sentinel after the tool result,
 *   - a user message `calculate: <expression>` -> `calculator_calculate`,
 *   - a user message `run code: <python>` -> `code_execute`.
 *
 * Streamed tool calls are emitted as argument fragments, like a real server.
 *
 * A user message starting with `reasoning:` answers like a vLLM-served
 * thinking model (Raon/Qwen): chain-of-thought in `message.reasoning`
 * (non-streamed) or `delta.reasoning` (streamed), final text in `content`.
 */

import http from 'node:http';

function parseArgs(argv) {
  const args = { port: 8000, apiKey: '', host: '127.0.0.1' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--port') {
      args.port = Number.parseInt(value ?? '8000', 10);
      index += 1;
    } else if (flag === '--api-key') {
      args.apiKey = value ?? '';
      index += 1;
    } else if (flag === '--host') {
      args.host = value ?? '127.0.0.1';
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const MODEL_ID = 'mock-model';
let mockCallCounter = 0;

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');

    if (args.apiKey && request.headers.authorization !== `Bearer ${args.apiKey}`) {
      sendJson(response, 401, { error: { message: 'invalid api key', type: 'authentication_error' } });
      return;
    }

    if (request.url === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.url === '/props') {
      sendJson(response, 200, {
        default_generation_settings: { n_predict: -1, temperature: 0.8 },
        total_slots: 1,
        model_path: '/mock/model.gguf',
      });
      return;
    }

    if (request.url === '/v1/models') {
      sendJson(response, 200, {
        object: 'list',
        data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'mock' }],
      });
      return;
    }

    if (request.url === '/v1/chat/completions') {
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        sendJson(response, 400, { error: { message: 'invalid json' } });
        return;
      }

      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const lastMessage = messages.at(-1) ?? {};
      const prompt = typeof lastMessage.content === 'string' ? lastMessage.content : '';
      const toolNames = new Set(
        (Array.isArray(parsed.tools) ? parsed.tools : [])
          .map((tool) => tool?.function?.name)
          .filter((name) => typeof name === 'string'),
      );
      const isProbe = toolNames.has('kaggle_kit_capability_probe');

      const transcript = messages
        .map((message) => (typeof message.content === 'string' ? message.content : ''))
        .join('\n');

      // A tool result normally ends the scripted round trip. The uploaded-file
      // flow is the one exception: it lists the vault, then reads the file the
      // user just uploaded, so the browser E2E exercises a real two-step loop.
      let scriptedCall = null;
      let scriptedFinishReason = 'tool_calls';
      if (lastMessage.role === 'tool') {
        const wanted = /analyze my uploaded file/i.test(transcript)
          ? 'files_analyze'
          : /read my uploaded file/i.test(transcript)
            ? 'files_read'
            : null;
        const listedId = /"id":"([0-9a-f-]{36})"/.exec(transcript)?.[1];
        const alreadyReturnedFile = /Uploaded file: budget\.csv/.test(transcript);
        if (wanted && listedId && !alreadyReturnedFile && toolNames.has(wanted)) {
          scriptedCall = {
            name: wanted,
            arguments: JSON.stringify(
              wanted === 'files_analyze'
                ? { file_id: listedId, question: 'Which department has the highest amount?' }
                : { file_id: listedId },
            ),
          };
        } else {
          sendJson(response, 200, {
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: MODEL_ID,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: isProbe ? 'KAGGLE_KIT_TOOL_PROBE_OK' : `Tool result received: ${prompt.slice(0, 300)}`,
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          });
          return;
        }
      }

      // Deterministic native tool calls, selected by the offered functions.
      if (!scriptedCall && toolNames.size > 0) {
        const inconsistent = /inconsistent calculate:\s*(.+)/i.exec(prompt);
        const calculate = /calculate:\s*(.+)/i.exec(prompt);
        const readFile = /read file:\s*(\S+)/i.exec(prompt);
        const analyzeFile = /analyze file:\s*(\S+)\s*::\s*([\s\S]+)/i.exec(prompt);
        const openUrl = /open url:\s*(\S+)/i.exec(prompt);
        const diagnostics = /^diagnostics:/i.test(prompt);
        const convert = /convert:\s*(-?[\d.]+(?:e[+-]?\d+)?)\s+(\S+)\s+(?:to|in|->)\s+(\S+)/i.exec(prompt);
        const runCode = /run code:\s*([\s\S]+)/i.exec(prompt);
        if ((/read my uploaded file/i.test(prompt) || /analyze my uploaded file/i.test(prompt)) && toolNames.has('files_list')) {
          scriptedCall = { name: 'files_list', arguments: '{}' };
        } else if (inconsistent && toolNames.has('calculator_calculate')) {
          // A protocol-violating response: valid tool-call data but the wrong
          // finish_reason. Used by the integration check to prove the bounded
          // corrective recovery of the tool loop against the built bundle.
          scriptedCall = { name: 'calculator_calculate', arguments: JSON.stringify({ expression: inconsistent[1].trim() }) };
          scriptedFinishReason = 'stop';
        } else if (calculate && toolNames.has('calculator_calculate')) {
          scriptedCall = { name: 'calculator_calculate', arguments: JSON.stringify({ expression: calculate[1].trim() }) };
        } else if (diagnostics && toolNames.has('diagnostics_check')) {
          scriptedCall = { name: 'diagnostics_check', arguments: '{}' };
        } else if (convert && toolNames.has('calculator_convert')) {
          scriptedCall = {
            name: 'calculator_convert',
            arguments: JSON.stringify({ value: Number(convert[1]), from: convert[2], to: convert[3] }),
          };
        } else if (runCode && toolNames.has('code_execute')) {
          scriptedCall = { name: 'code_execute', arguments: JSON.stringify({ language: 'python', code: runCode[1].trim() }) };
        } else if (readFile && toolNames.has('files_read')) {
          scriptedCall = { name: 'files_read', arguments: JSON.stringify({ file_id: readFile[1].trim() }) };
        } else if (analyzeFile && toolNames.has('files_analyze')) {
          scriptedCall = {
            name: 'files_analyze',
            arguments: JSON.stringify({ file_id: analyzeFile[1].trim(), question: analyzeFile[2].trim() }),
          };
        } else if (openUrl && toolNames.has('web_open')) {
          scriptedCall = { name: 'web_open', arguments: JSON.stringify({ url: openUrl[1].trim() }) };
        } else if (isProbe) {
          scriptedCall = { name: 'kaggle_kit_capability_probe', arguments: '{}' };
        }
      }

      if (scriptedCall) {
        mockCallCounter += 1;
        const callId = `mock-call-${mockCallCounter}`;
        if (parsed.stream) {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const split = Math.max(1, Math.floor(scriptedCall.arguments.length / 2));
          const frames = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: scriptedCall.name, arguments: scriptedCall.arguments.slice(0, split) } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: scriptedCall.arguments.slice(split) } }] }, finish_reason: 'tool_calls' }] },
          ];
          for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
          response.write('data: [DONE]\n\n');
          response.end();
          return;
        }
        sendJson(response, 200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: MODEL_ID,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: callId, type: 'function', function: scriptedCall }],
            },
            finish_reason: scriptedFinishReason,
          }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        });
        return;
      }

      const wantsReasoning = /^reasoning:/i.test(prompt);

      if (parsed.stream) {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        if (wantsReasoning) {
          // vLLM-style reasoning deltas arrive before (never inside) content.
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'mock ' } }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'thinking' } }] })}\n\n`,
          );
        }
        // The browser end-to-end test asks for a slower cadence so a
        // partially rendered answer can be observed deterministically.
        const slow = /^stream slowly:/i.test(prompt);
        const chunks = slow
          ? ['This ', 'is ', 'a ', 'slow ', 'streamed ', 'answer.']
          : ['This ', 'is ', 'a ', 'mock ', 'answer.'];
        let index = 0;
        const timer = setInterval(() => {
          if (index < chunks.length) {
            response.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`,
            );
            index += 1;
            return;
          }
          clearInterval(timer);
          response.write('data: [DONE]\n\n');
          response.end();
        }, slow ? 200 : 60);
        request.on('aborted', () => clearInterval(timer));
        response.on('close', () => clearInterval(timer));
        return;
      }

      sendJson(response, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message: wantsReasoning
              ? { role: 'assistant', content: `Mock answer for: ${prompt}`, reasoning: 'mock thinking' }
              : { role: 'assistant', content: `Mock answer for: ${prompt}` },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
      return;
    }

    sendJson(response, 404, { error: { message: `unknown route ${request.url}` } });
  });
});

server.listen(args.port, args.host, () => {
  process.stdout.write(
    `Mock upstream listening on http://${args.host}:${args.port}/v1` +
      (args.apiKey ? ' (api key required)' : ' (no api key)') +
      '\n',
  );
});
