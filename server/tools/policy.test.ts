import { describe, expect, it } from 'vitest';

import { DEFAULT_TOOL_PROFILE_SETTINGS } from '../../shared/tools/types';
import {
  grantMcpServer,
  parseToolArguments,
  sanitizeDiscoveredSchema,
  sanitizeToolProfileForStorage,
  sanitizeToolProfileSettings,
  ToolPolicyError,
  validateToolArguments,
} from './policy';

function profile(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS), ...overrides };
}

describe('tool profile policy', () => {
  it('strips direct sensitive header values and accepts only secret references', () => {
    const settings = sanitizeToolProfileSettings(profile({
      httpTools: [{
        id: 'lookup', name: 'Lookup', description: 'Read data', endpoint: 'https://api.example.com/data', method: 'GET',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, permission: 'read_only', timeoutMs: 5000,
        headers: [
          { name: 'Authorization', value: 'Bearer do-not-store' },
          { name: 'X-API-Key', value: 'also-secret' },
          { name: 'Accept', value: 'application/json' },
          { name: 'X-Tenant', value: 'not-safe-to-store' },
          { name: 'Authorization', secretRef: 'secret-header-1' },
          { name: 'Authorization', value: 'conflict', secretRef: 'secret-header-2' },
        ],
      }],
    }));
    expect(settings.httpTools).toHaveLength(1);
    expect(settings.httpTools[0]?.headers).toEqual([
      { name: 'Accept', value: 'application/json' },
      { name: 'Authorization', secretRef: 'secret-header-1' },
    ]);
    expect(JSON.stringify(settings)).not.toContain('do-not-store');
    expect(JSON.stringify(settings)).not.toContain('also-secret');
    expect(JSON.stringify(settings)).not.toContain('not-safe-to-store');
  });

  it('rejects unsafe URLs and filters malformed custom tools', () => {
    const settings = sanitizeToolProfileSettings(profile({
      httpTools: [
        { id: 'local', name: 'Local', endpoint: 'http://127.0.0.1/admin', method: 'GET', inputSchema: { type: 'object' } },
        { id: 'credentials', name: 'Creds', endpoint: 'https://user:pass@example.test/private', method: 'GET', inputSchema: { type: 'object' } },
        { id: 'ipv6-local', name: 'IPv6 local', endpoint: 'https://[::1]/admin', method: 'GET', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { id: 'nonstandard-port', name: 'Other port', endpoint: 'https://api.example.com:9443/data', method: 'GET', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { id: 'valid', name: 'Valid', endpoint: 'https://api.example.com/data', method: 'GET', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, permission: 'read_only', headers: [] },
      ],
    }));
    expect(settings.httpTools.map((tool) => tool.id)).toEqual(['valid']);
  });

  it('keeps an MCP grant only for the same previously confirmed target', () => {
    const selectedTool = { name: 'Read', serverToolName: 'read', description: 'Read data', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, selected: true, permission: 'read_only' };
    const previous = grantMcpServer(sanitizeToolProfileSettings(profile({
      mcpServers: [{ id: 'research', name: 'Research', transport: 'streamable_http', enabled: true, confirmed: false, url: 'https://mcp.example.com/mcp', timeoutMs: 5000, tools: [selectedTool] }],
    })), 'research');
    // Incoming JSON cannot grant a new target merely by setting confirmed.
    const forged = sanitizeToolProfileForStorage(profile({
      mcpServers: [{ id: 'research', name: 'Research', transport: 'streamable_http', enabled: true, confirmed: true, url: 'https://evil.example.com/mcp', timeoutMs: 5000, tools: [selectedTool] }],
    }), previous);
    expect(forged.mcpServers[0]?.confirmed).toBe(false);
    expect(forged.mcpServers[0]?.enabled).toBe(false);
    expect(forged.mcpServers[0]?.tools).toEqual([]);

    const retained = sanitizeToolProfileForStorage(profile({
      mcpServers: [{ id: 'research', name: 'Research', transport: 'streamable_http', enabled: true, confirmed: true, url: 'https://mcp.example.com/mcp', timeoutMs: 5000, tools: [selectedTool] }],
    }), previous);
    expect(retained.mcpServers[0]?.confirmed).toBe(true);
  });

  it('requires fresh discovery when the MCP endpoint or connection credentials change', () => {
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    const selected = { name: 'Read', serverToolName: 'read', description: 'Read data', inputSchema: schema, selected: true, permission: 'read_only' };
    const previous = grantMcpServer(sanitizeToolProfileSettings(profile({
      mcpServers: [{ id: 'research', name: 'Research', transport: 'streamable_http', enabled: true, confirmed: false, url: 'https://mcp.example.com/mcp', timeoutMs: 5000, headers: [], tools: [selected] }],
    })), 'research');

    for (const changedTarget of [
      { ...previous.mcpServers[0], url: 'https://other.example.com/mcp' },
      { ...previous.mcpServers[0], headers: [{ name: 'Authorization', secretRef: 'new-secret' }] },
      { ...previous.mcpServers[0], timeoutMs: 6000 },
      { ...previous.mcpServers[0], transport: 'stdio' as const, command: '/usr/bin/node' },
    ]) {
      const changed = sanitizeToolProfileForStorage(profile({ mcpServers: [changedTarget] }), previous);
      expect(changed.mcpServers[0]).toMatchObject({ confirmed: false, enabled: false, tools: [] });
    }
  });

  it('requires a fresh MCP grant before adding or changing a selected tool', () => {
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    const toolA = { name: 'Read', serverToolName: 'read', description: 'Read data', inputSchema: schema, selected: true, permission: 'read_only' };
    const toolB = { name: 'Write', serverToolName: 'write', description: 'Write data', inputSchema: schema, selected: false, permission: 'unknown' };
    const previous = grantMcpServer(sanitizeToolProfileSettings(profile({
      mcpServers: [{ id: 'research', name: 'Research', transport: 'streamable_http', enabled: true, confirmed: false, url: 'https://mcp.example.com/mcp', timeoutMs: 5000, tools: [toolA, toolB] }],
    })), 'research');

    const added = sanitizeToolProfileForStorage(profile({
      mcpServers: [{ ...previous.mcpServers[0], tools: [toolA, { ...toolB, selected: true }] }],
    }), previous);
    expect(added.mcpServers[0]).toMatchObject({ confirmed: false, enabled: false });

    const forgedTool = { name: 'Trusted read', serverToolName: 'not-discovered', description: 'Forged', inputSchema: schema, selected: true, permission: 'read_only' };
    const forged = sanitizeToolProfileForStorage(profile({
      mcpServers: [{ ...previous.mcpServers[0], tools: [toolA, forgedTool] }],
    }), previous);
    expect(forged.mcpServers[0]?.tools.map((tool) => tool.serverToolName)).toEqual(['read']);
    expect(forged.mcpServers[0]).toMatchObject({ confirmed: true, enabled: true });

    const tamperedSchema = sanitizeToolProfileForStorage(profile({
      mcpServers: [{ ...previous.mcpServers[0], tools: [{ ...toolA, inputSchema: { type: 'object', additionalProperties: true } }, toolB] }],
    }), previous);
    expect(tamperedSchema.mcpServers[0]?.tools[0]?.inputSchema).toEqual(schema);
    expect(tamperedSchema.mcpServers[0]?.confirmed).toBe(true);

    const downgradedPermission = sanitizeToolProfileForStorage(profile({
      mcpServers: [{ ...previous.mcpServers[0], tools: [{ ...toolA, permission: 'unknown' }, toolB] }],
    }), previous);
    expect(downgradedPermission.mcpServers[0]).toMatchObject({ confirmed: false, enabled: false });

    const broadGrant = grantMcpServer(sanitizeToolProfileSettings(profile({
      mcpServers: [{ ...previous.mcpServers[0], enabled: true, confirmed: false, tools: [toolA, { ...toolB, selected: true }] }],
    })), 'research');
    const narrowed = sanitizeToolProfileForStorage(profile({
      mcpServers: [{ ...broadGrant.mcpServers[0], tools: [toolA, toolB] }],
    }), broadGrant);
    expect(narrowed.mcpServers[0]).toMatchObject({ confirmed: true, enabled: true });
  });

  it('grants only an explicitly selected remote Streamable HTTP connection', () => {
    const selectedTool = { name: 'Read', serverToolName: 'read', description: 'Read data', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, selected: true, permission: 'read_only' };
    const base = sanitizeToolProfileSettings(profile({
      mcpServers: [{ id: 'research', name: 'Research', transport: 'streamable_http', enabled: false, confirmed: false, url: 'https://mcp.example.com/mcp', timeoutMs: 5000, tools: [selectedTool] }],
    }));
    const granted = grantMcpServer(base, 'research');
    expect(granted.mcpServers[0]).toMatchObject({ confirmed: true, enabled: true });
    expect(() => grantMcpServer(base, 'missing')).toThrow(ToolPolicyError);

    const empty = sanitizeToolProfileSettings(profile({
      mcpServers: [{ id: 'empty', name: 'Empty', transport: 'streamable_http', enabled: false, confirmed: false, url: 'https://mcp.example.com/mcp', timeoutMs: 5000, tools: [] }],
    }));
    expect(() => grantMcpServer(empty, 'empty')).toThrow(/select at least one/i);

    const local = sanitizeToolProfileSettings(profile({
      mcpServers: [{ id: 'local', name: 'Local', transport: 'stdio', enabled: false, confirmed: false, command: '/usr/bin/node', timeoutMs: 5000, tools: [selectedTool] }],
    }));
    expect(() => grantMcpServer(local, 'local')).toThrow(/remote Streamable HTTP/i);
  });

  it('validates argument schemas and rejects prototype-pollution keys', () => {
    const schema = { type: 'object', properties: { query: { type: 'string', maxLength: 10 } }, required: ['query'], additionalProperties: false };
    expect(validateToolArguments(schema, { query: 'ok' })).toEqual({ query: 'ok' });
    expect(() => validateToolArguments(schema, { query: 12 })).toThrow(ToolPolicyError);
    expect(() => validateToolArguments(schema, { query: 'ok', extra: true })).toThrow(ToolPolicyError);
    expect(() => parseToolArguments('{"__proto__":{"polluted":true}}', 128)).toThrow(/forbidden property/i);
    expect(() => parseToolArguments('{"query":"' + 'x'.repeat(20) + '"}', 10)).toThrow(/byte limit/i);
    expect(() => parseToolArguments('{"query":1e400}', 128)).toThrow(/non-finite numbers/i);
  });

  it('refuses remote references, unsafe regex and oversized discovered schemas', () => {
    expect(sanitizeDiscoveredSchema({ type: 'object', $ref: 'https://evil.test/schema.json' })).toBeNull();
    expect(sanitizeDiscoveredSchema({ type: 'object', properties: { ok: { type: 'string' } }, additionalProperties: false })).toEqual({ type: 'object', properties: { ok: { type: 'string' } }, additionalProperties: false });
    expect(sanitizeDiscoveredSchema({ type: 'object', properties: { value: { type: 'string', pattern: '(a+)+$' } } })).toBeNull();
    expect(sanitizeDiscoveredSchema({ type: 'object', patternProperties: { '.*': { type: 'string' } } })).toBeNull();
    expect(sanitizeDiscoveredSchema({ type: 'object', description: 'x'.repeat(25_000) })).toBeNull();
  });
});
