#!/usr/bin/env node
/**
 * A tiny OpenAI-compatible server for local development and manual testing.
 *
 * It behaves like llama.cpp's server: it serves /v1/models, /v1/chat/completions
 * (streaming and non streaming), /health and /props. Use it to try the chat
 * interface without a GPU.
 *
 *   node tools/mock-upstream.mjs --port 8000 --api-key demo-key
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

      const prompt = (parsed.messages ?? []).at(-1)?.content ?? '';

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
