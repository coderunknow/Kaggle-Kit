/**
 * Small HTTP helpers shared by the proxy routes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiErrorKind } from '../shared/api/errors';

export class HttpError extends Error {
  readonly status: number;
  readonly kind?: ApiErrorKind;
  readonly hint?: string;

  constructor(status: number, message: string, kind?: ApiErrorKind, hint?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (kind) this.kind = kind;
    if (hint) this.hint = hint;
  }
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) {
      throw new HttpError(413, `The request body is larger than ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  if (size === 0) {
    throw new HttpError(400, 'The request body is empty.');
  }

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'The request body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) {
    // The response is already on its way; ending it is the only thing left.
    response.end();
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

export function sendError(
  response: ServerResponse,
  status: number,
  message: string,
  extra: { kind?: ApiErrorKind; hint?: string } = {},
): void {
  sendJson(response, status, {
    error: {
      message,
      ...(extra.kind ? { kind: extra.kind } : {}),
      ...(extra.hint ? { hint: extra.hint } : {}),
    },
  });
}
