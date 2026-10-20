import { isIP } from 'node:net';
import Ajv, { type ValidateFunction } from 'ajv';
import { clampToolLimits, DEFAULT_CODE_SANDBOX, type CodeSandboxSettings, type HttpHeaderSetting, type HttpToolSetting, type McpDiscoveredTool, type McpServerSetting, type ToolPermission, type ToolProfileSettings } from '../../shared/tools/types';
import { httpModelName, mcpModelName } from '../../shared/tools/catalog';
import { isPublicAddress } from './web';

const ajv = new Ajv({
  allErrors: false,
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateSchema: true,
  ownProperties: true,
  addUsedSchema: false,
});
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SAFE_SECRET_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const VALID_PERMISSIONS = new Set<ToolPermission>(['read_only', 'write', 'unknown']);
const SENSITIVE_HEADER = /(?:authorization|api[-_]?key|token|secret|password|credential)/i;
const SAFE_LITERAL_HEADERS = new Set([
  'accept', 'accept-language', 'cache-control', 'content-type', 'if-modified-since',
  'if-none-match', 'user-agent', 'x-request-id',
]);
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  'pattern', 'patternProperties', 'propertyNames', 'uniqueItems', 'contains',
  'not', 'if', 'then', 'else', 'dependentSchemas',
]);
const BRANCHING_SCHEMA_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf']);
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'proxy-authorization', 'proxy-connection', 'cookie', 'set-cookie', 'origin', 'referer', 'accept-encoding']);

export class ToolPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolPolicyError';
  }
}

export function sanitizeToolProfileSettings(raw: unknown): ToolProfileSettings {
  if (!isRecord(raw)) throw new ToolPolicyError('Tool profile settings must be an object.');
  const webRaw = isRecord(raw.web) ? raw.web : {};
  const codeRaw = isRecord(raw.code) ? raw.code : {};
  const settings: ToolProfileSettings = {
    enabled: raw.enabled === true,
    allowedTools: uniqueStrings(raw.allowedTools, 48, 64),
    limits: clampToolLimits(isRecord(raw.limits) ? raw.limits as never : undefined),
    historyPersistence: raw.historyPersistence === true,
    web: {
      provider: webRaw.provider === 'brave' ? 'brave' : 'disabled',
      ...(validSecretRef(webRaw.secretRef) ? { secretRef: webRaw.secretRef } : {}),
      ...(webRaw.storageRightsConfirmed === true ? { storageRightsConfirmed: true } : {}),
    },
    httpTools: sanitizeHttpTools(raw.httpTools),
    mcpServers: sanitizeMcpServers(raw.mcpServers),
    code: sanitizeCodeSettings(codeRaw),
  };
  const modelNames = new Set<string>();
  for (const tool of settings.httpTools) {
    const name = httpModelName(tool.id);
    if (modelNames.has(name)) throw new ToolPolicyError('Configured HTTP tool names collide after normalization.');
    modelNames.add(name);
  }
  for (const server of settings.mcpServers) {
    const connectionNames = new Set<string>();
    for (const tool of server.tools) {
      const normalized = mcpModelName(server, tool.serverToolName);
      if (connectionNames.has(normalized) || modelNames.has(normalized)) {
        throw new ToolPolicyError('Configured MCP tool names collide after normalization.');
      }
      connectionNames.add(normalized);
      modelNames.add(normalized);
    }
  }
  return settings;
}

function sanitizeHttpTools(raw: unknown): HttpToolSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 16).flatMap((entry): HttpToolSetting[] => {
    if (!isRecord(entry) || !validId(entry.id) || typeof entry.name !== 'string') return [];
    const endpoint = safeConfiguredUrl(entry.endpoint);
    if (!endpoint) return [];
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(entry.method))
      ? entry.method as HttpToolSetting['method']
      : 'GET';
    const schema = sanitizeJsonSchema(entry.inputSchema);
    if (!schema) return [];
    const name = boundedText(entry.name, 80);
    if (!name) return [];
    return [{
      id: entry.id,
      name,
      description: boundedText(entry.description, 500),
      endpoint,
      method,
      inputSchema: schema,
      headers: sanitizeHeaders(entry.headers),
      permission: validPermission(entry.permission) ? entry.permission : 'unknown',
      timeoutMs: boundedNumber(entry.timeoutMs, 1_000, 30_000, 10_000),
      ...(typeof entry.responsePointer === 'string' && entry.responsePointer.length <= 256 && isJsonPointer(entry.responsePointer)
        ? { responsePointer: entry.responsePointer }
        : {}),
    }];
  });
}

function sanitizeMcpServers(raw: unknown): McpServerSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).flatMap((entry): McpServerSetting[] => {
    if (!isRecord(entry) || !validId(entry.id) || typeof entry.name !== 'string') return [];
    const transport = entry.transport === 'stdio' ? 'stdio' : 'streamable_http';
    const url = safeMcpUrl(entry.url);
    const activeTools = sanitizeMcpTools(entry.tools);
    return [{
      id: entry.id,
      name: boundedText(entry.name, 80),
      transport,
      // Connections are not implicitly granted by a saved profile. The only
      // way to set confirmed=true is an explicit server-side grant route.
      enabled: entry.enabled === true && transport === 'streamable_http' && Boolean(url),
      confirmed: false,
      ...(url ? { url } : {}),
      headers: sanitizeHeaders(entry.headers),
      timeoutMs: boundedNumber(entry.timeoutMs, 1_000, 30_000, 10_000),
      tools: activeTools,
    }];
  });
}

function sanitizeMcpTools(raw: unknown): McpDiscoveredTool[] {
  if (!Array.isArray(raw)) return [];
  const names = new Set<string>();
  return raw.slice(0, 64).flatMap((entry): McpDiscoveredTool[] => {
    if (!isRecord(entry) || typeof entry.serverToolName !== 'string') return [];
    const name = boundedText(entry.serverToolName, 128);
    if (!name || names.has(name)) return [];
    const inputSchema = sanitizeJsonSchema(entry.inputSchema);
    if (!inputSchema) return [];
    names.add(name);
    return [{
      name: boundedText(entry.name, 80) || name,
      serverToolName: name,
      description: boundedText(entry.description, 500),
      inputSchema,
      selected: entry.selected === true,
      // Server metadata is not trusted; unknown is the safe default and the
      // UI's explicit read-only grant is required before auto-execution.
      permission: validPermission(entry.permission) ? entry.permission : 'unknown',
    }];
  });
}

function sanitizeHeaders(raw: unknown): HttpHeaderSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 16).flatMap((entry): HttpHeaderSetting[] => {
    if (!isRecord(entry) || typeof entry.name !== 'string') return [];
    const name = entry.name.trim();
    if (!/^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) return [];
    const secretRef = validSecretRef(entry.secretRef) ? entry.secretRef : undefined;
    const value = typeof entry.value === 'string' ? entry.value : undefined;
    if (value && (value.length > 512 || containsHeaderControl(value))) return [];
    if (SENSITIVE_HEADER.test(name) && !secretRef) return [];
    if (value !== undefined && !SAFE_LITERAL_HEADERS.has(name.toLowerCase())) return [];
    if (secretRef && value !== undefined) return [];
    return [{ name, ...(value !== undefined ? { value } : {}), ...(secretRef ? { secretRef } : {}) }];
  });
}

function sanitizeCodeSettings(raw: Record<string, unknown>): CodeSandboxSettings {
  const provider = raw.provider === 'docker' && isPinnedPythonImage(raw.image) ? 'docker' : 'disabled';
  return {
    provider,
    image: provider === 'docker' && typeof raw.image === 'string' ? raw.image : DEFAULT_CODE_SANDBOX.image,
    isolation: 'strict',
    network: 'none',
    timeoutMs: boundedNumber(raw.timeoutMs, 1_000, 60_000, DEFAULT_CODE_SANDBOX.timeoutMs),
    memoryMb: boundedNumber(raw.memoryMb, 64, 2048, DEFAULT_CODE_SANDBOX.memoryMb),
    cpuCores: boundedDecimal(raw.cpuCores, 0.1, 2, DEFAULT_CODE_SANDBOX.cpuCores),
    maxProcesses: boundedNumber(raw.maxProcesses, 1, 128, DEFAULT_CODE_SANDBOX.maxProcesses),
    outputBytes: boundedNumber(raw.outputBytes, 256, 32_768, DEFAULT_CODE_SANDBOX.outputBytes),
  };
}

export function sanitizeToolProfileForStorage(raw: unknown, previous: ToolProfileSettings | null): ToolProfileSettings {
  const incoming = sanitizeToolProfileSettings(raw);
  if (!previous) return incoming;
  const oldById = new Map(previous.mcpServers.map((server) => [server.id, server]));
  incoming.mcpServers = incoming.mcpServers.map((server) => {
    const old = oldById.get(server.id);
    const sameTarget = old?.transport === server.transport && old?.url === server.url &&
      old?.timeoutMs === server.timeoutMs && stableStringify(old?.headers ?? []) === stableStringify(server.headers ?? []);
    if (!sameTarget || !old) {
      // A discovery result is bound to the exact endpoint and credentials that
      // produced it. Force a fresh discovery after any target change rather
      // than letting stale names/schemas be granted at a different server.
      return { ...server, tools: [], confirmed: false, enabled: false };
    }
    // Tool names, descriptions and schemas are server-discovered data. Never
    // accept them from the browser: only preserve previously discovered tools,
    // applying the user's selected/permission changes to those known records.
    const submittedTools = new Map(server.tools.map((tool) => [tool.serverToolName, tool]));
    const tools = old.tools.flatMap((previous) => {
      const submitted = submittedTools.get(previous.serverToolName);
      if (!submitted) return [];
      return [{
        ...previous,
        selected: submitted.selected,
        permission: validPermission(submitted.permission) ? submitted.permission : previous.permission,
      }];
    });
    const selectionIsPreviouslyGranted = tools.filter((tool) => tool.selected).every((tool) => {
      const previous = old.tools.find((entry) => entry.serverToolName === tool.serverToolName && entry.selected);
      return previous !== undefined && mcpToolGrantFingerprint(previous) === mcpToolGrantFingerprint(tool);
    });
    const confirmed = Boolean(selectionIsPreviouslyGranted && old.confirmed);
    return { ...server, tools, confirmed, enabled: Boolean(server.enabled && confirmed) };
  });
  return incoming;
}

function mcpToolGrantFingerprint(tool: McpDiscoveredTool): string {
  return stableStringify({
    serverToolName: tool.serverToolName,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    permission: tool.permission,
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function grantMcpServer(settings: ToolProfileSettings, serverId: string): ToolProfileSettings {
  let found = false;
  const mcpServers = settings.mcpServers.map((server) => {
    if (server.id !== serverId) return server;
    found = true;
    if (server.transport !== 'streamable_http' || !server.url) throw new ToolPolicyError('Only configured remote Streamable HTTP MCP connections can be granted. Local stdio is disabled.');
    if (!server.tools.some((tool) => tool.selected)) throw new ToolPolicyError('Discover and select at least one MCP tool before granting this connection.');
    return { ...server, confirmed: true, enabled: true };
  });
  if (!found) throw new ToolPolicyError('The MCP connection was not found in this profile.');
  return { ...settings, mcpServers };
}

export function validateToolArguments(schema: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new ToolPolicyError('Tool arguments must be a JSON object.');
  rejectDangerousKeys(raw, 0);
  let validator: ValidateFunction;
  try { validator = ajv.compile(schema); } catch {
    ajv.removeSchema(schema);
    throw new ToolPolicyError('This tool has an unsupported or invalid input schema.');
  }
  let valid: boolean;
  let detail: string | undefined;
  try {
    valid = validator(raw);
    detail = validator.errors?.[0]?.message;
  } finally {
    // Schemas can be supplied by user-configured tools or remote MCP servers.
    // Do not retain an unbounded cache of attacker-controlled schema objects.
    ajv.removeSchema(schema);
  }
  if (!valid) throw new ToolPolicyError(detail ? `Tool arguments are invalid: ${detail}` : 'Tool arguments do not match the declared schema.');
  return raw;
}

export function parseToolArguments(raw: string, maxBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new ToolPolicyError(`Tool arguments exceed the ${maxBytes}-byte limit.`);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ToolPolicyError('Tool arguments are not valid JSON.'); }
  if (!isRecord(value)) throw new ToolPolicyError('Tool arguments must be a JSON object.');
  rejectDangerousKeys(value, 0);
  return value;
}

export function isSensitiveField(name: string): boolean {
  return /(?:secret|password|token|authorization|credential|api.?key)/i.test(name);
}

export function sanitizeDiscoveredSchema(raw: unknown): Record<string, unknown> | null {
  return sanitizeJsonSchema(raw);
}

function sanitizeJsonSchema(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  let serialized: string;
  try { serialized = JSON.stringify(raw); } catch { return null; }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 24_000) return null;
  if (countSchemaNodes(raw, 0) > 500) return null;
  if (containsRemoteRef(raw, 0) || !isBoundedSchema(raw, 0, 0)) return null;
  try {
    ajv.compile(raw);
    return structuredClone(raw);
  } catch {
    return null;
  } finally {
    ajv.removeSchema(raw);
  }
}

function containsRemoteRef(value: unknown, depth: number): boolean {
  if (depth > 16) return true;
  if (Array.isArray(value)) return value.some((item) => containsRemoteRef(item, depth + 1));
  if (!isRecord(value)) return false;
  if (typeof value.$ref === 'string' && !value.$ref.startsWith('#/')) return true;
  return Object.values(value).some((child) => containsRemoteRef(child, depth + 1));
}

function countSchemaNodes(value: unknown, depth: number): number {
  if (depth > 16) return 501;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countSchemaNodes(item, depth + 1), 1);
  if (!isRecord(value)) return 1;
  return Object.values(value).reduce<number>((sum, item) => sum + countSchemaNodes(item, depth + 1), 1);
}

function isBoundedSchema(value: unknown, depth: number, branchDepth: number): boolean {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.every((item) => isBoundedSchema(item, depth + 1, branchDepth));
  if (!isRecord(value)) return true;
  for (const [key, child] of Object.entries(value)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) return false;
    if (BRANCHING_SCHEMA_KEYWORDS.has(key)) {
      if (!Array.isArray(child) || child.length === 0 || child.length > 8 || branchDepth >= 2) return false;
      if (!child.every((branch) => isBoundedSchema(branch, depth + 1, branchDepth + 1))) return false;
    } else if (!isBoundedSchema(child, depth + 1, branchDepth)) return false;
  }
  return true;
}

function safeConfiguredUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    if (url.search) return null;
    const hostname = url.hostname.toLowerCase();
    const address = hostname.replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local') || hostname.endsWith('.test') || hostname === 'metadata.google.internal' || hostname === 'instance-data') return null;
    if (isIP(address) && !isPublicAddress(address)) return null;
    if (url.port && !['80', '443'].includes(url.port)) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function safeMcpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (url.port && url.port !== '443') return null;
    const hostname = url.hostname.toLowerCase();
    const address = hostname.replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local') || hostname.endsWith('.test') || hostname === 'metadata.google.internal' || hostname === 'instance-data') return null;
    if (isIP(address) && !isPublicAddress(address)) return null;
    return url.toString();
  } catch { return null; }
}

function isPinnedPythonImage(value: unknown): value is string {
  return typeof value === 'string' && /^python:3\.(?:11|12|13)-alpine@sha256:[a-f0-9]{64}$/.test(value);
}

function isJsonPointer(value: string): boolean {
  return value === '' || (value.startsWith('/') && !/~(?![01])/.test(value));
}

function rejectDangerousKeys(value: unknown, depth: number): void {
  if (depth > 16) throw new ToolPolicyError('Tool arguments are nested too deeply.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new ToolPolicyError('Tool arguments must not contain non-finite numbers.');
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new ToolPolicyError('Tool arguments contain too many array items.');
    for (const item of value) rejectDangerousKeys(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ToolPolicyError('Tool arguments contain a forbidden property.');
    rejectDangerousKeys(child, depth + 1);
  }
}

function validId(value: unknown): value is string { return typeof value === 'string' && SAFE_ID.test(value); }
function validSecretRef(value: unknown): value is string { return typeof value === 'string' && SAFE_SECRET_REF.test(value); }
function validPermission(value: unknown): value is ToolPermission { return typeof value === 'string' && VALID_PERMISSIONS.has(value as ToolPermission); }
function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  }).join('').trim().slice(0, max);
}
function containsHeaderControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0 || code === 0x0a || code === 0x0d;
  });
}
function boundedNumber(value: unknown, min: number, max: number, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback; }
function boundedDecimal(value: unknown, min: number, max: number, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value)) * 10) / 10 : fallback; }
function uniqueStrings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value.slice(0, maxItems)) if (typeof item === 'string' && item.length <= maxLength && /^[a-zA-Z0-9_-]+$/.test(item)) result.add(item);
  return [...result];
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
