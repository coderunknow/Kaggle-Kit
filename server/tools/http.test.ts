import { describe, expect, it } from 'vitest';

import type { HttpToolSetting } from '../../shared/tools/types';
import { applyResponsePointer, executeConfiguredHttpTool } from './http';

const setting: HttpToolSetting = {
  id: 'test',
  name: 'Test endpoint',
  description: 'Read remote test data',
  endpoint: 'https://api.example.com/data',
  method: 'GET',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
  headers: [],
  permission: 'read_only',
  timeoutMs: 5000,
};

describe('configured HTTP tools', () => {
  it('selects only own JSON properties and rejects prototype traversal', () => {
    expect(applyResponsePointer({ data: { value: 7 } }, '/data/value')).toBe(7);
    expect(() => applyResponsePointer({}, '/toString')).toThrow(/not found/i);
    expect(() => applyResponsePointer({ safe: true }, '/__proto__')).toThrow(/not found/i);
    expect(() => applyResponsePointer({ items: [1] }, '/items/length')).toThrow(/not found/i);
  });

  it('fails closed when DNS resolves to a private address', async () => {
    await expect(executeConfiguredHttpTool(setting, { query: 'hello' }, {}, {
      timeoutMs: 5000,
      maxOutputBytes: 1000,
      lookup: async () => [{ address: '10.0.0.4', family: 4 }],
    })).rejects.toThrow(/private, link-local, (?:loopback, )?or reserved/i);
  });

  it('refuses nonstandard ports before making a network request', async () => {
    await expect(executeConfiguredHttpTool({ ...setting, endpoint: 'https://api.example.com:9443/data' }, {}, {}, {
      timeoutMs: 5000,
      maxOutputBytes: 1000,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })).rejects.toThrow(/standard web ports/i);
  });

  it('refuses credential-like arguments before they can be placed in a URL or request body', async () => {
    await expect(executeConfiguredHttpTool(setting, { query: 'hello', filter: { api_token: 'private-value' } }, {}, {
      timeoutMs: 5000,
      maxOutputBytes: 1000,
      lookup: async () => { throw new Error('credential argument must be rejected before DNS'); },
    })).rejects.toThrow(/credential-like HTTP arguments/i);
  });

  it('rejects an already-aborted request without opening a socket', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(executeConfiguredHttpTool(setting, {}, {}, {
      timeoutMs: 5000,
      maxOutputBytes: 1000,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/i);
  });
});
