import type { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import { readJsonBody } from './http';

/** A minimal async-iterable that behaves like an IncomingMessage body. */
function jsonRequest(payload: string, chunkSize = 64): IncomingMessage {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    chunks.push(Buffer.from(payload.slice(offset, offset + chunkSize)));
  }
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as IncomingMessage;
}

describe('readJsonBody', () => {
  it('rejects a body that grows past the limit as 413 instead of buffering it', async () => {
    // The limit is crossed between two chunks: the reader must stop
    // accumulating instead of holding the whole body in memory.
    const payload = `{"a":"${'x'.repeat(2_000)}"}`;
    await expect(readJsonBody(jsonRequest(payload), 1_500)).rejects.toMatchObject({
      status: 413,
    });
  });

  it('accepts a body of exactly the limit (inclusive) and rejects one byte more', async () => {
    // `{"a":"` + 992 x + `"}` = exactly 1,000 bytes.
    const exact = `{"a":"${'x'.repeat(992)}"}`;
    expect(Buffer.byteLength(exact, 'utf8')).toBe(1_000);
    await expect(readJsonBody(jsonRequest(exact), 1_000)).resolves.toMatchObject({ a: expect.any(String) });

    const over = `{"a":"${'x'.repeat(993)}"}`;
    expect(Buffer.byteLength(over, 'utf8')).toBe(1_001);
    await expect(readJsonBody(jsonRequest(over), 1_000)).rejects.toMatchObject({ status: 413 });
  });

  it('rejects an empty body as 400', async () => {
    await expect(readJsonBody(jsonRequest(''), 1_000)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a JSON array as 400 because handlers expect an object', async () => {
    await expect(readJsonBody(jsonRequest('[1,2,3]'), 1_000)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects invalid JSON as 400, including a body that only fails at the parser depth limit', async () => {
    await expect(readJsonBody(jsonRequest('{"a":1'), 1_000)).rejects.toMatchObject({ status: 400 });

    // A megabyte of opening brackets: invalid JSON, and deep enough that a
    // naive parser could overflow its stack. The handler must answer 400,
    // not crash the process.
    const deep = '['.repeat(1_000_000);
    await expect(readJsonBody(jsonRequest(deep, 8_192), 1_048_576)).rejects.toMatchObject({ status: 400 });
  });
});
