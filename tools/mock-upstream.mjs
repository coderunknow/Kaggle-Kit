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

      // A tool result ends the scripted round trip unless it is a corrective retry.
      if (lastMessage.role === 'tool') {
        const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';
        const badArgsMatch = /corrective-bad-args:\s*(.+)/i.exec(userPrompt);
        const badToolMatch = /corrective-bad-tool:\s*(.+)/i.exec(userPrompt);
        if (prompt.includes('"correctiveGuidance"') && (badArgsMatch || badToolMatch) && toolNames.has('calculator_calculate')) {
          const expr = (badArgsMatch?.[1] ?? badToolMatch?.[1] ?? '2 + 2').trim();
          mockCallCounter += 1;
          sendJson(response, 200, {
            id: 'chatcmpl-mock-retry',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: MODEL_ID,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: `mock-call-${mockCallCounter}`,
                  type: 'function',
                  function: { name: 'calculator_calculate', arguments: JSON.stringify({ expression: expr }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 18, completion_tokens: 10, total_tokens: 28 },
          });
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
              content: isProbe ? 'KAGGLE_KIT_TOOL_PROBE_OK' : `Tool result received: ${prompt.slice(0, 300)}`,
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        });
        return;
      }

      // Deterministic native tool calls, selected by the offered functions.
      let scriptedCall = null;
      if (toolNames.size > 0) {
        const firstUserPrompt = messages.find((m) => m.role === 'user')?.content ?? prompt;
        const rawMarkupRetry = /Correction required \(1 retry permitted\)/i.test(prompt)
          && /corrective-raw-markup:\s*(.+)/i.exec(firstUserPrompt);
        const rawMarkupInitial = /corrective-raw-markup:\s*(.+)/i.exec(prompt);
        const badArgs = /corrective-bad-args:\s*(.+)/i.exec(prompt);
        const badTool = /corrective-bad-tool:\s*(.+)/i.exec(prompt);
        const calculate = /calculate:\s*(.+)/i.exec(prompt);
        const convertMatch = /convert:\s*([0-9.]+)\s+(\S+)\s+to\s+(\S+)/i.exec(prompt);
        const listFilesMatch = /\blist (?:uploaded )?files\b/i.exec(prompt);
        const readFileMatch = /read file:\s*(\S+)/i.exec(prompt);
        const analyzeFileMatch = /analyze file:\s*(\S+)/i.exec(prompt);
        const diagnosticsMatch = /\bcheck diagnostics\b/i.exec(prompt);
        const openUrlMatch = /open url:\s*(https?:\/\/\S+)/i.exec(prompt);
        const searchWebMatch = /search web:\s*(.+)/i.exec(prompt);
        const callHttpMatch = /call http:\s*(.+)/i.exec(prompt);
        const callMcpMatch = /call mcp:\s*(.+)/i.exec(prompt);
        const runCode = /run code:\s*([\s\S]+)/i.exec(prompt);
        const httpToolName = [...toolNames].find((name) => name.startsWith('http_'));
        const mcpToolName = [...toolNames].find((name) => name.startsWith('mcp_'));

        if (rawMarkupInitial && !/Correction required/i.test(prompt)) {
          sendJson(response, 200, {
            id: 'chatcmpl-mock-raw-markup',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: MODEL_ID,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: `<tool_call>{"name":"calculator_calculate","arguments":{"expression":"${rawMarkupInitial[1].trim()}"}}</tool_call>`,
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 },
          });
          return;
        }
        if (rawMarkupRetry && toolNames.has('calculator_calculate')) {
          scriptedCall = { name: 'calculator_calculate', arguments: JSON.stringify({ expression: rawMarkupRetry[1].trim() }) };
        } else if (badArgs && toolNames.has('calculator_calculate')) {
          scriptedCall = { name: 'calculator_calculate', arguments: JSON.stringify({ expr: badArgs[1].trim() }) };
        } else if (badTool) {
          scriptedCall = { name: 'nonexistent_calculator', arguments: JSON.stringify({ expression: badTool[1].trim() }) };
        } else if (calculate && toolNames.has('calculator_calculate')) {
          scriptedCall = { name: 'calculator_calculate', arguments: JSON.stringify({ expression: calculate[1].trim() }) };
        } else if (convertMatch && toolNames.has('calculator_convert')) {
          scriptedCall = {
            name: 'calculator_convert',
            arguments: JSON.stringify({
              value: Number(convertMatch[1]),
              from: convertMatch[2],
              to: convertMatch[3],
            }),
          };
        } else if (listFilesMatch && toolNames.has('files_list')) {
          scriptedCall = { name: 'files_list', arguments: '{}' };
        } else if (readFileMatch && toolNames.has('files_read')) {
          scriptedCall = { name: 'files_read', arguments: JSON.stringify({ file_id: readFileMatch[1].trim() }) };
        } else if (analyzeFileMatch && toolNames.has('files_analyze')) {
          scriptedCall = { name: 'files_analyze', arguments: JSON.stringify({ file_id: analyzeFileMatch[1].trim(), question: 'Summarize the uploaded file.' }) };
        } else if (diagnosticsMatch && toolNames.has('diagnostics_check')) {
          scriptedCall = { name: 'diagnostics_check', arguments: '{}' };
        } else if (openUrlMatch && toolNames.has('web_open')) {
          scriptedCall = { name: 'web_open', arguments: JSON.stringify({ url: openUrlMatch[1].trim() }) };
        } else if (searchWebMatch && toolNames.has('web_search')) {
          scriptedCall = { name: 'web_search', arguments: JSON.stringify({ query: searchWebMatch[1].trim(), max_results: 3 }) };
        } else if (callHttpMatch && httpToolName) {
          scriptedCall = { name: httpToolName, arguments: JSON.stringify({ query: callHttpMatch[1].trim() }) };
        } else if (callMcpMatch && mcpToolName) {
          scriptedCall = { name: mcpToolName, arguments: JSON.stringify({ query: callMcpMatch[1].trim() }) };
        } else if (runCode && toolNames.has('code_execute')) {
          scriptedCall = { name: 'code_execute', arguments: JSON.stringify({ language: 'python', code: runCode[1].trim() }) };
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
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        });
        return;
      }

      if (parsed.stream) {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const chunks = ['This ', 'is ', 'a ', 'mock ', 'answer.'];
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
        }, 60);
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
            message: { role: 'assistant', content: `Mock answer for: ${prompt}` },
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
