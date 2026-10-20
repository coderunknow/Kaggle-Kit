import { describe, expect, it } from 'vitest';

import { buildToolDefinitions, findToolDefinition, httpModelName, mcpModelName, toOpenAITools } from './catalog';
import { DEFAULT_TOOL_PROFILE_SETTINGS, type ToolProfileSettings } from './types';

function profile(overrides: Partial<ToolProfileSettings> = {}): ToolProfileSettings {
  return {
    ...structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS),
    ...overrides,
    limits: { ...DEFAULT_TOOL_PROFILE_SETTINGS.limits, ...overrides.limits },
    web: { ...DEFAULT_TOOL_PROFILE_SETTINGS.web, ...overrides.web },
  };
}

describe('server-built tool catalog', () => {
  it('offers only enabled, explicitly allowlisted built-ins', () => {
    const settings = profile({ enabled: true, allowedTools: ['calculator_calculate', 'unknown_from_model'] });
    expect(buildToolDefinitions(settings).map((entry) => entry.function.name)).toEqual(['calculator_calculate']);
    expect(findToolDefinition(settings, 'unknown_from_model')).toBeUndefined();
    expect(findToolDefinition(settings, 'calculator_convert')).toBeUndefined();
  });

  it('keeps public page opening independent from Brave Search credentials', () => {
    const settings = profile({ enabled: true, allowedTools: ['web_open', 'web_search'] });
    expect(buildToolDefinitions(settings).map((entry) => entry.function.name)).toEqual(['web_open']);
  });

  it('does not advertise code execution without an enabled sandbox', () => {
    const settings = profile({ enabled: true, allowedTools: ['code_execute'], code: { ...DEFAULT_TOOL_PROFILE_SETTINGS.code, provider: 'disabled' } });
    expect(buildToolDefinitions(settings)).toEqual([]);
    const enabled = profile({ enabled: true, allowedTools: ['code_execute'], code: { ...settings.code, provider: 'docker' } });
    const definition = buildToolDefinitions(enabled)[0];
    expect(definition?.requiresApproval).toBe(true);
    expect(definition?.permission).toBe('unknown');
  });

  it('uses normalized, server-generated names for HTTP and MCP tools', () => {
    const settings = profile({
      enabled: true,
      allowedTools: ['http_lookup', 'mcp_research_search'],
      httpTools: [{
        id: 'lookup', name: 'Lookup', description: 'Read remote data', endpoint: 'https://api.example.test/lookup', method: 'GET',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, headers: [], permission: 'read_only', timeoutMs: 5000,
      }],
      mcpServers: [{
        id: 'research', name: 'Research', transport: 'streamable_http', enabled: true, confirmed: true,
        url: 'https://mcp.example.test/mcp', timeoutMs: 5000, tools: [{
          name: 'Search', serverToolName: 'search', description: 'Search', selected: true, permission: 'unknown',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      }],
    });
    expect(httpModelName('lookup')).toBe('http_lookup');
    expect(mcpModelName(settings.mcpServers[0]!, 'search')).toBe('mcp_research_search');
    const definitions = buildToolDefinitions(settings);
    expect(definitions.map((entry) => entry.function.name)).toEqual(['http_lookup', 'mcp_research_search']);
    expect(toOpenAITools(definitions)[0]).not.toHaveProperty('permission');
    expect(toOpenAITools(definitions)[1]?.function.name).toBe('mcp_research_search');
  });

  it('requires a provider credential before offering web search', () => {
    const noSecret = profile({ enabled: true, allowedTools: ['web_search'], web: { provider: 'brave' } });
    expect(buildToolDefinitions(noSecret)).toEqual([]);
    const withSecret = profile({ enabled: true, allowedTools: ['web_search'], web: { provider: 'brave', secretRef: 'brave-1' } });
    expect(buildToolDefinitions(withSecret)[0]?.function.name).toBe('web_search');
  });
});
