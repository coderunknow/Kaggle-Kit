import { describe, expect, it } from 'vitest';

import type { McpServerSetting } from '../../shared/tools/types';
import { callMcpTool, discoverMcpTools, McpConnectionError } from './mcp';

const remoteServer: McpServerSetting = {
  id: 'research',
  name: 'Research',
  transport: 'streamable_http',
  enabled: false,
  confirmed: false,
  url: 'https://mcp.example.com/mcp',
  timeoutMs: 2_000,
  tools: [],
};

describe('remote MCP policy', () => {
  it('refuses an ungranted server before attempting a connection', async () => {
    await expect(callMcpTool(remoteServer, {
      name: 'Search', serverToolName: 'search', description: 'Search',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      selected: true, permission: 'read_only',
    }, {}, { headers: {}, timeoutMs: 2_000 })).rejects.toThrow(/not been granted/i);
  });

  it('fails closed when the MCP hostname resolves to a private address', async () => {
    await expect(discoverMcpTools({ ...remoteServer, url: 'https://mcp.example.com/mcp' }, {
      headers: {}, timeoutMs: 2_000,
      lookup: async () => [{ address: '10.0.0.8', family: 4 }],
    })).rejects.toThrow(/private|non-public/i);
  });

  it('requires HTTPS and standard port 443 for remote MCP', async () => {
    await expect(discoverMcpTools({ ...remoteServer, url: 'http://mcp.example.com/mcp' }, {
      headers: {}, timeoutMs: 2_000,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })).rejects.toThrow(McpConnectionError);
    await expect(discoverMcpTools({ ...remoteServer, url: 'https://mcp.example.com:8443/mcp' }, {
      headers: {}, timeoutMs: 2_000,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })).rejects.toThrow(/standard web ports/i);
  });

  it('refuses local stdio connections rather than starting a process', async () => {
    await expect(discoverMcpTools({
      ...remoteServer, transport: 'stdio', command: '/usr/bin/node', args: ['server.js'], url: undefined,
    }, { headers: {}, timeoutMs: 2_000 })).rejects.toThrow(/stdio execution is disabled/i);
  });
});
