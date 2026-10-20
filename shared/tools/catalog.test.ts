import { describe, expect, it } from 'vitest';

import {
  buildToolDefinitions,
  findToolDefinition,
  httpModelName,
  mcpModelName,
  measureToolCatalog,
  summarizeToolSchema,
  toOpenAITools,
} from './catalog';
import { DEFAULT_TOOL_PROFILE_SETTINGS, MAX_ACTIVE_TOOLS_PER_TURN, MAX_TOOL_CATALOG_BYTES, type ToolProfileSettings } from './types';

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

  it('omits files_read and files_analyze when uploadedFileCount is 0 while keeping files_list active', () => {
    const settings = profile({
      enabled: true,
      allowedTools: ['calculator_calculate', 'files_list', 'files_read', 'files_analyze'],
    });
    const noFiles = measureToolCatalog(settings, undefined, { uploadedFileCount: 0 });
    expect(noFiles.definitions.map((d) => d.function.name)).toEqual(['calculator_calculate', 'files_list']);
    expect(noFiles.omittedTools).toEqual([
      expect.objectContaining({ name: 'files_read', reason: 'no_uploaded_files' }),
      expect.objectContaining({ name: 'files_analyze', reason: 'no_uploaded_files' }),
    ]);

    const withFiles = measureToolCatalog(settings, undefined, { uploadedFileCount: 2 });
    expect(withFiles.definitions.map((d) => d.function.name)).toEqual([
      'calculator_calculate',
      'files_list',
      'files_read',
      'files_analyze',
    ]);
    expect(withFiles.omittedTools).toEqual([]);
  });

  it('caps large tool catalogs within MAX_TOOL_CATALOG_BYTES and MAX_ACTIVE_TOOLS_PER_TURN', () => {
    const httpTools = Array.from({ length: 16 }, (_, i) => ({
      id: `svc_${i + 1}`,
      name: `Service ${i + 1}`,
      description: 'X'.repeat(500),
      endpoint: `https://api.example.com/v1/service/${i + 1}`,
      method: 'GET' as const,
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string' as const, maxLength: 400, description: 'Y'.repeat(200) },
          filter: { type: 'string' as const, maxLength: 200, description: 'Z'.repeat(200) },
        },
        required: ['query'],
        additionalProperties: false as const,
      },
      headers: [],
      permission: 'read_only' as const,
      timeoutMs: 10_000,
    }));
    const settings = profile({
      enabled: true,
      allowedTools: [
        'calculator_calculate',
        'calculator_convert',
        'files_list',
        'files_read',
        'files_analyze',
        'web_open',
        'diagnostics_check',
        ...httpTools.map((t) => httpModelName(t.id)),
      ],
      httpTools,
    });

    const measured = measureToolCatalog(settings, undefined, { uploadedFileCount: 1 });
    expect(measured.definitions.length).toBeLessThanOrEqual(MAX_ACTIVE_TOOLS_PER_TURN);
    expect(measured.serializedBytes).toBeLessThanOrEqual(MAX_TOOL_CATALOG_BYTES);
    expect(measured.omittedTools.some((item) => item.reason === 'budget_exceeded')).toBe(true);
  });

  it('summarizes required and optional schema fields for corrective guidance', () => {
    const settings = profile({ enabled: true, allowedTools: ['calculator_convert'] });
    const definition = findToolDefinition(settings, 'calculator_convert')!;
    const summary = summarizeToolSchema(definition);
    expect(summary).toContain('calculator_convert');
    expect(summary).toContain('required: value, from, to');
    expect(summary).toContain('additionalProperties: false');
  });
});
