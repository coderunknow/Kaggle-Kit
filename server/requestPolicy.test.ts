import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertJsonContentType,
  isAllowedOrigin,
  resolveWithinDirectory,
  watchForDisconnect,
} from './requestPolicy';

function fakeRequest(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('origin policy', () => {
  it('accepts a request without an origin header', () => {
    expect(isAllowedOrigin(fakeRequest({}), { allowedOrigins: null }).allowed).toBe(true);
  });

  it('accepts the origin of the request itself', () => {
    const result = isAllowedOrigin(
      fakeRequest({ origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' }),
      { allowedOrigins: null },
    );
    expect(result.allowed).toBe(true);
  });

  it('refuses a DNS-rebinding self-origin (attacker Host and Origin agree)', () => {
    // evil.test resolves to 127.0.0.1; the browser then sends Host and
    // Origin that match each other. Self-origin must not auto-trust it.
    const result = isAllowedOrigin(
      fakeRequest({ origin: 'http://evil.test:8787', host: 'evil.test:8787' }),
      { allowedOrigins: null },
    );
    expect(result.allowed).toBe(false);
  });

  it('refuses a LAN-name self-origin unless it is configured explicitly', () => {
    const request = fakeRequest({ origin: 'http://llama.home:8787', host: 'llama.home:8787' });
    expect(isAllowedOrigin(request, { allowedOrigins: null }).allowed).toBe(false);
    expect(isAllowedOrigin(request, { allowedOrigins: ['http://llama.home:8787'] }).allowed).toBe(true);
  });

  it('accepts localhost and IPv6 loopback self-origins', () => {
    expect(isAllowedOrigin(
      fakeRequest({ origin: 'http://localhost:8787', host: 'localhost:8787' }),
      { allowedOrigins: null },
    ).allowed).toBe(true);
    expect(isAllowedOrigin(
      fakeRequest({ origin: 'http://[::1]:8787', host: '[::1]:8787' }),
      { allowedOrigins: null },
    ).allowed).toBe(true);
  });

  it('refuses an origin of another site', () => {
    const result = isAllowedOrigin(
      fakeRequest({ origin: 'https://evil.test', host: '127.0.0.1:8787' }),
      { allowedOrigins: null },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('evil.test');
  });

  it('accepts a configured extra origin', () => {
    const result = isAllowedOrigin(
      fakeRequest({ origin: 'http://localhost:5173', host: '127.0.0.1:8787' }),
      { allowedOrigins: ['http://localhost:5173'] },
    );
    expect(result.allowed).toBe(true);
  });

  it('does not accept a configured origin that only shares a prefix', () => {
    const result = isAllowedOrigin(
      fakeRequest({ origin: 'http://localhost:5173.evil.test', host: '127.0.0.1:8787' }),
      { allowedOrigins: ['http://localhost:5173'] },
    );
    expect(result.allowed).toBe(false);
  });
});

describe('content type enforcement', () => {
  it('accepts application/json', () => {
    expect(() =>
      assertJsonContentType(fakeRequest({ 'content-type': 'application/json' })),
    ).not.toThrow();
    expect(() =>
      assertJsonContentType(fakeRequest({ 'content-type': 'application/json; charset=utf-8' })),
    ).not.toThrow();
  });

  it('refuses a missing or different content type', () => {
    expect(() => assertJsonContentType(fakeRequest({}))).toThrowError(/application\/json/);
    expect(() =>
      assertJsonContentType(fakeRequest({ 'content-type': 'text/plain' })),
    ).toThrowError(/application\/json/);
  });
});

describe('static file containment', () => {
  const base = path.resolve('/tmp/app/dist/client');

  it('resolves a legitimate asset', () => {
    expect(resolveWithinDirectory(base, 'assets/index.js')).toBe(
      path.join(base, 'assets/index.js'),
    );
    expect(resolveWithinDirectory(base, 'index.html')).toBe(path.join(base, 'index.html'));
    expect(resolveWithinDirectory(base, '')).toBe(base);
  });

  it('refuses a traversal out of the client directory', () => {
    expect(resolveWithinDirectory(base, '../server/secrets.json')).toBeNull();
    expect(resolveWithinDirectory(base, '../../etc/passwd')).toBeNull();
    expect(resolveWithinDirectory(base, 'assets/../../secrets.json')).toBeNull();
  });

  it('refuses a sibling directory that starts with the same name', () => {
    expect(resolveWithinDirectory(base, '../client-secret/secret.txt')).toBeNull();
  });

  it('refuses an absolute path', () => {
    expect(resolveWithinDirectory(base, '/etc/passwd')).toBeNull();
  });

  it('refuses a null byte', () => {
    expect(resolveWithinDirectory(base, 'index.html\u0000.txt')).toBeNull();
  });
});

describe('disconnect detection', () => {
  it('reports a disconnect when the response was not finished', () => {
    const response = new EventEmitter() as ServerResponse;
    Object.defineProperty(response, 'writableFinished', { value: false, writable: true });
    let disconnected = 0;
    const stop = watchForDisconnect(response, () => {
      disconnected += 1;
    });

    response.emit('close');
    expect(disconnected).toBe(1);

    stop();
    response.emit('close');
    expect(disconnected).toBe(1);
  });

  it('ignores the close of a response that was written completely', () => {
    const response = new EventEmitter() as ServerResponse;
    Object.defineProperty(response, 'writableFinished', { value: true, writable: true });
    let disconnected = 0;
    watchForDisconnect(response, () => {
      disconnected += 1;
    });

    response.emit('close');
    expect(disconnected).toBe(0);
  });
});
