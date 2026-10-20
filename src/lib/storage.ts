/**
 * Browser storage helpers.
 *
 * Only non-sensitive data is persisted by default:
 *  - API profiles (without any key material)
 *  - conversation history
 *  - UI preferences
 *
 * API keys are only written to browser storage when the user explicitly opts
 * into the "browser" credential mode, and the key material lives in a
 * separate store so it can be wiped independently.
 */

import type {
  ApiProfile,
  ChatMessage,
  Conversation,
  MessageStatus,
  UiPreferences,
} from '../../shared/domain';
import { DEFAULT_UI_PREFERENCES, THEMES } from '../../shared/domain';
import {
  clampToolLimits,
  DEFAULT_TOOL_PROFILE_SETTINGS,
  type ToolProfileSettings,
  type ConversationToolSettings,
  type ToolTraceRecord,
  type SourceCitation,
  type UploadedFileReference,
} from '../../shared/tools/types';

export const STORAGE_KEYS = {
  profiles: 'kaggle-kit.profiles.v1',
  conversations: 'kaggle-kit.conversations.v1',
  preferences: 'kaggle-kit.prefs.v1',
  /** Opt-in only: plain text API keys in the browser. */
  browserKeys: 'kaggle-kit.browser-keys.v1',
  /** Unsent text per conversation, so a reload does not lose a draft. */
  drafts: 'kaggle-kit.drafts.v1',
} as const;

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 500;
const MAX_DRAFTS = 50;
const MAX_DRAFT_LENGTH = 20_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SAFE_STORED_HEADER_VALUES = new Set([
  'accept', 'accept-language', 'cache-control', 'content-type', 'if-modified-since',
  'if-none-match', 'user-agent', 'x-request-id',
]);
const FORBIDDEN_STORED_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'proxy-authorization',
  'proxy-connection', 'cookie', 'set-cookie', 'origin', 'referer', 'accept-encoding',
]);
const TRANSIENT_TOOL_CONTENT_PLACEHOLDER = '[This tool-derived answer was not saved because tool-history persistence was off or provider retention rights were not confirmed.]';

const MESSAGE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'complete',
  'cancelled',
  'error',
]);

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const store = storage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Storage quota exceeded or storage disabled: keep the app usable.
  }
}

export function removeKey(key: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Remove every key this application owns. */
export function clearAllStoredData(): void {
  for (const key of Object.values(STORAGE_KEYS)) {
    removeKey(key);
  }
}

export function loadProfiles(): ApiProfile[] {
  const value = readJson<ApiProfile[]>(STORAGE_KEYS.profiles, []);
  if (!Array.isArray(value)) return [];
  return value
    .filter((profile): profile is ApiProfile => Boolean(profile) && typeof profile === 'object')
    .map((profile) => ({
      ...profile,
      // Defensive: a key must never be part of a persisted profile.
      ...(Object.prototype.hasOwnProperty.call(profile, 'apiKey')
        ? { apiKey: undefined }
        : {}),
      tools: sanitizeStoredToolProfile((profile as unknown as Record<string, unknown>).tools),
    }));
}

function sanitizeStoredToolProfile(raw: unknown): ToolProfileSettings {
  const defaults = structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const value = raw as Record<string, unknown>;
  const web = value.web && typeof value.web === 'object' && !Array.isArray(value.web)
    ? value.web as Record<string, unknown>
    : {};
  const code = value.code && typeof value.code === 'object' && !Array.isArray(value.code)
    ? value.code as Record<string, unknown>
    : {};
  const validEntries = (entry: unknown): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
  return {
    enabled: value.enabled === true,
    allowedTools: Array.isArray(value.allowedTools)
      ? [...new Set(value.allowedTools.filter((tool): tool is string => typeof tool === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(tool)))].slice(0, 48)
      : [],
    limits: clampToolLimits(value.limits && typeof value.limits === 'object' ? value.limits as never : undefined),
    historyPersistence: value.historyPersistence === true,
    web: {
      provider: web.provider === 'brave' ? 'brave' : 'disabled',
      ...(typeof web.secretRef === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(web.secretRef) ? { secretRef: web.secretRef } : {}),
      ...(web.storageRightsConfirmed === true ? { storageRightsConfirmed: true } : {}),
    },
    httpTools: sanitizeStoredHttpTools(value.httpTools, validEntries),
    mcpServers: sanitizeStoredMcpServers(value.mcpServers, validEntries),
    code: {
      provider: code.provider === 'docker' ? 'docker' : 'disabled',
      image: typeof code.image === 'string' ? code.image.slice(0, 256) : defaults.code.image,
      isolation: 'strict',
      network: 'none',
      timeoutMs: boundedStoredNumber(code.timeoutMs, 1_000, 60_000, defaults.code.timeoutMs),
      memoryMb: boundedStoredNumber(code.memoryMb, 64, 2_048, defaults.code.memoryMb),
      cpuCores: boundedStoredNumber(code.cpuCores, 0.1, 2, defaults.code.cpuCores),
      maxProcesses: boundedStoredNumber(code.maxProcesses, 1, 128, defaults.code.maxProcesses),
      outputBytes: boundedStoredNumber(code.outputBytes, 256, 32_768, defaults.code.outputBytes),
    },
  };
}

function sanitizeStoredHttpTools(
  raw: unknown,
  validEntries: (entry: unknown) => entry is Record<string, unknown>,
): ToolProfileSettings['httpTools'] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 16).flatMap((entry): ToolProfileSettings['httpTools'] => {
    if (!validEntries(entry) || typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.id)) return [];
    const endpoint = safeStoredToolUrl(entry.endpoint, false);
    if (!endpoint || typeof entry.name !== 'string' || !entry.inputSchema || typeof entry.inputSchema !== 'object' || Array.isArray(entry.inputSchema)) return [];
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(entry.method))
      ? entry.method as NonNullable<ToolProfileSettings['httpTools']>[number]['method']
      : 'GET';
    return [{
      id: entry.id,
      name: entry.name.slice(0, 80),
      description: typeof entry.description === 'string' ? entry.description.slice(0, 500) : '',
      endpoint,
      method,
      inputSchema: entry.inputSchema as NonNullable<ToolProfileSettings['httpTools']>[number]['inputSchema'],
      headers: sanitizeStoredHeaders(entry.headers),
      permission: entry.permission === 'read_only' || entry.permission === 'write' || entry.permission === 'unknown' ? entry.permission : 'unknown',
      timeoutMs: boundedStoredNumber(entry.timeoutMs, 1_000, 30_000, 10_000),
      ...(typeof entry.responsePointer === 'string' && entry.responsePointer.length <= 256 && (entry.responsePointer === '' || entry.responsePointer.startsWith('/'))
        ? { responsePointer: entry.responsePointer }
        : {}),
    }];
  });
}

function sanitizeStoredMcpServers(
  raw: unknown,
  validEntries: (entry: unknown) => entry is Record<string, unknown>,
): ToolProfileSettings['mcpServers'] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).flatMap((entry): ToolProfileSettings['mcpServers'] => {
    if (!validEntries(entry) || typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.id) || typeof entry.name !== 'string') return [];
    const transport = entry.transport === 'stdio' ? 'stdio' : 'streamable_http';
    const url = safeStoredToolUrl(entry.url, transport === 'stdio', transport === 'streamable_http');
    return [{
      id: entry.id,
      name: entry.name.slice(0, 80),
      transport,
      enabled: entry.enabled === true && transport === 'streamable_http' && Boolean(url),
      confirmed: entry.confirmed === true && transport === 'streamable_http' && Boolean(url),
      ...(url ? { url } : {}),
      headers: sanitizeStoredHeaders(entry.headers),
      timeoutMs: boundedStoredNumber(entry.timeoutMs, 1_000, 30_000, 10_000),
      tools: sanitizeStoredMcpTools(entry.tools, validEntries),
    }];
  });
}

function sanitizeStoredMcpTools(
  raw: unknown,
  validEntries: (entry: unknown) => entry is Record<string, unknown>,
): NonNullable<ToolProfileSettings['mcpServers']>[number]['tools'] {
  if (!Array.isArray(raw)) return [];
  const names = new Set<string>();
  return raw.slice(0, 64).flatMap((entry) => {
    if (!validEntries(entry) || typeof entry.serverToolName !== 'string') return [];
    const serverToolName = entry.serverToolName.slice(0, 128);
    if (!serverToolName || names.has(serverToolName) || !entry.inputSchema || typeof entry.inputSchema !== 'object' || Array.isArray(entry.inputSchema)) return [];
    names.add(serverToolName);
    return [{
      serverToolName,
      name: typeof entry.name === 'string' ? entry.name.slice(0, 80) : serverToolName,
      description: typeof entry.description === 'string' ? entry.description.slice(0, 500) : '',
      inputSchema: entry.inputSchema as NonNullable<ToolProfileSettings['mcpServers']>[number]['tools'][number]['inputSchema'],
      selected: entry.selected === true,
      permission: entry.permission === 'read_only' || entry.permission === 'write' || entry.permission === 'unknown' ? entry.permission : 'unknown',
    }];
  });
}

function sanitizeStoredHeaders(raw: unknown): NonNullable<ToolProfileSettings['httpTools']>[number]['headers'] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 16).flatMap((entry): NonNullable<ToolProfileSettings['httpTools']>[number]['headers'] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const header = entry as Record<string, unknown>;
    if (typeof header.name !== 'string' || !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(header.name)) return [];
    const name = header.name;
    const normalized = name.toLowerCase();
    if (FORBIDDEN_STORED_HEADERS.has(normalized)) return [];
    const secretRef = typeof header.secretRef === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(header.secretRef)
      ? header.secretRef
      : undefined;
    const value = typeof header.value === 'string' ? header.value : undefined;
    if (secretRef && value !== undefined) return [];
    if (secretRef) return [{ name, secretRef }];
    if (value === undefined || !SAFE_STORED_HEADER_VALUES.has(normalized) || value.length > 512 || value.includes('\r') || value.includes('\n') || value.includes('\x00')) return [];
    return [{ name, value }];
  });
}

function safeStoredToolUrl(raw: unknown, allowMissing = false, requireHttps = false): string | undefined {
  if (raw === undefined && allowMissing) return undefined;
  if (typeof raw !== 'string' || raw.length > 2_048) return undefined;
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || (requireHttps && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) return undefined;
    if ((url.protocol === 'http:' && url.port && url.port !== '80') || (url.protocol === 'https:' && url.port && url.port !== '443')) return undefined;
    if (url.protocol === 'https:' && !url.port) return url.toString();
    if (url.protocol === 'http:' && !url.port) return url.toString();
    return url.toString();
  } catch {
    return undefined;
  }
}

function boundedStoredNumber(raw: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(minimum, Math.min(maximum, raw)) : fallback;
}

export function saveProfiles(profiles: ApiProfile[]): void {
  writeJson(
    STORAGE_KEYS.profiles,
    profiles.map((profile) => {
      const safeProfile = { ...profile } as ApiProfile & { apiKey?: unknown };
      delete safeProfile.apiKey;
      safeProfile.tools = sanitizeStoredToolProfile(profile.tools);
      return safeProfile;
    }),
  );
}

/**
 * Make one stored message safe to render.
 *
 * Stored data can be old, hand edited or damaged. A message without a role,
 * a string content or an identifier is dropped; optional fields are only
 * copied when they have the expected type.
 */
export function sanitizeStoredMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.role !== 'user' && value.role !== 'assistant') return null;
  if (typeof value.content !== 'string') return null;
  if (typeof value.id !== 'string' || value.id === '') return null;

  const storedStatus = typeof value.status === 'string' ? value.status : 'complete';
  // A message that was still pending when the tab was closed can never
  // finish. Showing it as cancelled is truthful and keeps the text.
  const status: MessageStatus =
    storedStatus === 'pending'
      ? 'cancelled'
      : MESSAGE_STATUSES.has(storedStatus)
        ? (storedStatus as MessageStatus)
        : 'complete';

  const message: ChatMessage = {
    id: value.id,
    role: value.role,
    content: value.content,
    status,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
  };

  if (typeof value.model === 'string') message.model = value.model;
  if (typeof value.reasoning === 'string') message.reasoning = value.reasoning;
  if (typeof value.toolNote === 'string') message.toolNote = value.toolNote.slice(0, 1_000);
  if (typeof value.finishReason === 'string') message.finishReason = value.finishReason;
  if (typeof value.errorKind === 'string') {
    message.errorKind = value.errorKind as ChatMessage['errorKind'];
  }
  if (typeof value.errorMessage === 'string') message.errorMessage = value.errorMessage;
  if (typeof value.errorHint === 'string') message.errorHint = value.errorHint;
  if (value.transport === 'stream' || value.transport === 'complete') {
    message.transport = value.transport;
  }
  if (value.streamFellBack === true) message.streamFellBack = true;
  if (Array.isArray(value.toolTrace)) message.toolTrace = sanitizeStoredToolTrace(value.toolTrace);
  if (Array.isArray(value.sourceCitations)) message.sourceCitations = sanitizeSourceCitations(value.sourceCitations);
  if (Array.isArray(value.attachments)) message.attachments = sanitizeStoredAttachments(value.attachments);

  if (value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage)) {
    const usage = value.usage as Record<string, unknown>;
    const tokenUsage: ChatMessage['usage'] = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
      if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) {
        tokenUsage[key] = usage[key] as number;
      }
    }
    if (Object.keys(tokenUsage).length > 0) message.usage = tokenUsage;
  }

  return message;
}

function sanitizeStoredToolTrace(raw: unknown[]): ToolTraceRecord[] {
  return raw.slice(0, 24).flatMap((entry): ToolTraceRecord[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.toolName !== 'string') return [];
    const statuses = new Set(['requested', 'awaiting_approval', 'approved', 'running', 'succeeded', 'failed', 'denied', 'cancelled', 'interrupted']);
    const status = typeof value.status === 'string' && statuses.has(value.status) ? value.status as ToolTraceRecord['status'] : 'interrupted';
    const pending = status === 'awaiting_approval' || status === 'running' || status === 'approved';
    return [{
      id: value.id.slice(0, 128),
      toolName: value.toolName.slice(0, 64),
      status: pending ? 'interrupted' : status,
      approvalRequired: value.approvalRequired === true,
      ...(pending ? { approvalState: 'stale' as const } : value.approvalState === 'approved' || value.approvalState === 'denied' || value.approvalState === 'not_required' || value.approvalState === 'stale'
        ? { approvalState: value.approvalState }
        : {}),
      safeArguments: sanitizeSafeObject(value.safeArguments),
      ...(typeof value.target === 'string' ? { target: value.target.slice(0, 256) } : {}),
      requestedAt: typeof value.requestedAt === 'string' ? value.requestedAt : new Date(0).toISOString(),
      ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
      ...(typeof value.completedAt === 'string' ? { completedAt: value.completedAt } : {}),
      ...(typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) ? { durationMs: Math.max(0, Math.min(value.durationMs, 300_000)) } : {}),
      ...(typeof value.resultSummary === 'string' ? { resultSummary: value.resultSummary.slice(0, 512) } : {}),
      ...(typeof value.error === 'string' ? { error: value.error.slice(0, 1_000) } : {}),
      ...(Array.isArray(value.citations) ? { citations: sanitizeSourceCitations(value.citations) } : {}),
    }];
  });
}

function sanitizeSourceCitations(raw: unknown[]): SourceCitation[] {
  return raw.slice(0, 16).flatMap((entry): SourceCitation[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.url !== 'string' || value.url.length > 2_048) return [];
    try {
      const url = new URL(value.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
      return [{
        url: url.toString(),
        ...(typeof value.title === 'string' ? { title: value.title.slice(0, 240) } : {}),
        ...(typeof value.publisher === 'string' ? { publisher: value.publisher.slice(0, 128) } : {}),
        ...(typeof value.retrievedAt === 'string' ? { retrievedAt: value.retrievedAt.slice(0, 64) } : {}),
      }];
    } catch { return []; }
  });
}

function sanitizeStoredAttachments(raw: unknown[]): UploadedFileReference[] {
  return raw.slice(0, 16).flatMap((entry): UploadedFileReference[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.name !== 'string') return [];
    return [{
      id: value.id.slice(0, 96),
      name: stripControlCharacters(value.name.replace(/[\\/]/g, '')).slice(0, 160),
      mediaType: typeof value.mediaType === 'string' ? value.mediaType.slice(0, 128) : 'application/octet-stream',
      size: typeof value.size === 'number' && Number.isFinite(value.size) ? Math.max(0, Math.min(MAX_FILE_BYTES, value.size)) : 0,
      extractedCharacters: typeof value.extractedCharacters === 'number' ? Math.max(0, Math.min(100_000, value.extractedCharacters)) : 0,
      ...(value.truncated === true ? { truncated: true } : {}),
    }];
  });
}

function stripControlCharacters(value: string): string {
  return [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  }).join('');
}

function sanitizeSafeObject(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 6) return {};
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
    if (/(?:secret|password|token|authorization|credential|api.?key)/i.test(key)) output[key.slice(0, 64)] = '[redacted]';
    else if (typeof child === 'string') output[key.slice(0, 64)] = child.slice(0, 1_000);
    else if (typeof child === 'number' || typeof child === 'boolean' || child === null) output[key.slice(0, 64)] = child;
    else if (Array.isArray(child)) output[key.slice(0, 64)] = child.slice(0, 32).map((item) => typeof item === 'string' ? item.slice(0, 512) : item && typeof item === 'object' ? sanitizeSafeObject(item, depth + 1) : item);
    else if (typeof child === 'object') output[key.slice(0, 64)] = sanitizeSafeObject(child, depth + 1);
  }
  return output;
}

export function loadConversations(): Conversation[] {
  const value = readJson<unknown[]>(STORAGE_KEYS.conversations, []);
  if (!Array.isArray(value)) return [];

  return value
    .map((raw): Conversation | null => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const conversation = raw as Record<string, unknown>;
      if (typeof conversation.id !== 'string' || conversation.id === '') return null;
      if (!Array.isArray(conversation.messages)) return null;

      const retainToolHistory = conversation.toolHistoryPersistence === true;
      const messages = conversation.messages
        .map(sanitizeStoredMessage)
        .filter((message): message is ChatMessage => message !== null)
        .slice(-MAX_MESSAGES_PER_CONVERSATION)
        .map((message) => {
          if (retainToolHistory) return message;
          const { toolTrace: _trace, sourceCitations: _citations, toolJobId: _jobId, ...ordinary } = message;
          return ordinary;
        });

      return {
        id: conversation.id,
        title:
          typeof conversation.title === 'string' && conversation.title.trim()
            ? conversation.title
            : 'Conversation',
        profileId: typeof conversation.profileId === 'string' ? conversation.profileId : null,
        messages,
        createdAt:
          typeof conversation.createdAt === 'string'
            ? conversation.createdAt
            : new Date().toISOString(),
        updatedAt:
          typeof conversation.updatedAt === 'string'
            ? conversation.updatedAt
            : new Date().toISOString(),
        ...(typeof conversation.toolHistoryPersistence === 'boolean'
          ? { toolHistoryPersistence: conversation.toolHistoryPersistence }
          : {}),
        ...(conversation.toolSettings && typeof conversation.toolSettings === 'object'
          ? { toolSettings: sanitizeConversationToolSettings(conversation.toolSettings) }
          : {}),
        ...(Array.isArray(conversation.uploadedFiles)
          ? { uploadedFiles: sanitizeStoredAttachments(conversation.uploadedFiles) }
          : {}),
      };
    })
    .filter((conversation): conversation is Conversation => conversation !== null)
    .slice(0, MAX_CONVERSATIONS);
}

export function saveConversations(conversations: Conversation[]): void {
  const safe = conversations.slice(0, MAX_CONVERSATIONS).map((conversation) => {
    let transientToolContentSeen = false;
    const messages = conversation.messages.map((message) => {
      if (message.transientToolContent === true) transientToolContentSeen = true;
      const mustNotPersistContent = transientToolContentSeen && message.role === 'assistant';
      if (mustNotPersistContent) {
        const {
          reasoning: _reasoning,
          toolTrace: _trace,
          sourceCitations: _citations,
          toolJobId: _jobId,
          transientToolContent: _transient,
          ...safeMessage
        } = message;
        return { ...safeMessage, content: TRANSIENT_TOOL_CONTENT_PLACEHOLDER };
      }
      if (!conversation.toolHistoryPersistence) {
        const { toolTrace: _trace, sourceCitations: _citations, toolJobId: _jobId, transientToolContent: _transient, ...ordinary } = message;
        return ordinary;
      }
      const { toolJobId: _jobId, transientToolContent: _transient, ...persistentMessage } = message;
      const trace = message.toolTrace ? sanitizeStoredToolTrace(message.toolTrace) : undefined;
      const citations = message.sourceCitations ? sanitizeSourceCitations(message.sourceCitations) : undefined;
      return {
        ...persistentMessage,
        ...(trace ? { toolTrace: trace } : {}),
        ...(citations ? { sourceCitations: citations } : {}),
      };
    });
    return { ...conversation, messages };
  });
  writeJson(STORAGE_KEYS.conversations, safe);
}

function sanitizeConversationToolSettings(raw: unknown): ConversationToolSettings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(Array.isArray(value.toolIds) ? { toolIds: value.toolIds.filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id)).slice(0, 48) } : {}),
    ...(typeof value.maxRounds === 'number' && Number.isFinite(value.maxRounds) ? { maxRounds: Math.max(1, Math.min(8, Math.floor(value.maxRounds))) } : {}),
    ...(typeof value.maxCalls === 'number' && Number.isFinite(value.maxCalls) ? { maxCalls: Math.max(1, Math.min(24, Math.floor(value.maxCalls))) } : {}),
    ...(typeof value.loopTimeoutMs === 'number' && Number.isFinite(value.loopTimeoutMs) ? { loopTimeoutMs: Math.max(1, Math.min(300_000, Math.floor(value.loopTimeoutMs))) } : {}),
    ...(typeof value.historyPersistence === 'boolean' ? { historyPersistence: value.historyPersistence } : {}),
    ...(typeof value.selectionRecovery === 'boolean' ? { selectionRecovery: value.selectionRecovery } : {}),
  };
}

export function loadPreferences(): UiPreferences {
  const value = readJson<Partial<UiPreferences>>(STORAGE_KEYS.preferences, {});
  const theme =
    typeof value.theme === 'string' && (THEMES as readonly string[]).includes(value.theme)
      ? (value.theme as UiPreferences['theme'])
      : DEFAULT_UI_PREFERENCES.theme;

  return {
    activeProfileId:
      typeof value.activeProfileId === 'string' ? value.activeProfileId : null,
    activeConversationId:
      typeof value.activeConversationId === 'string' ? value.activeConversationId : null,
    theme,
    sendOnEnter:
      typeof value.sendOnEnter === 'boolean'
        ? value.sendOnEnter
        : DEFAULT_UI_PREFERENCES.sendOnEnter,
  };
}

export function savePreferences(preferences: UiPreferences): void {
  writeJson(STORAGE_KEYS.preferences, preferences);
}

/** The drafts of the composer, keyed by conversation id. */
export function loadDrafts(): Record<string, string> {
  const value = readJson<Record<string, unknown>>(STORAGE_KEYS.drafts, {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const drafts: Record<string, string> = {};
  for (const [id, text] of Object.entries(value)) {
    if (typeof text !== 'string') continue;
    if (!text.trim()) continue;
    drafts[id] = text.slice(0, MAX_DRAFT_LENGTH);
    if (Object.keys(drafts).length >= MAX_DRAFTS) break;
  }
  return drafts;
}

export function saveDrafts(drafts: Record<string, string>): void {
  const trimmed: Record<string, string> = {};
  for (const [id, text] of Object.entries(drafts)) {
    if (!text.trim()) continue;
    trimmed[id] = text.slice(0, MAX_DRAFT_LENGTH);
    if (Object.keys(trimmed).length >= MAX_DRAFTS) break;
  }
  writeJson(STORAGE_KEYS.drafts, trimmed);
}

export function removeDraft(conversationId: string): void {
  const drafts = loadDrafts();
  if (!(conversationId in drafts)) return;
  delete drafts[conversationId];
  saveDrafts(drafts);
}

/** Plain text keys, only written when the user opts into browser storage. */
export function loadBrowserKeys(): Record<string, string> {
  const value = readJson<Record<string, string>>(STORAGE_KEYS.browserKeys, {});
  if (!value || typeof value !== 'object') return {};
  return value;
}

export function saveBrowserKeys(keys: Record<string, string>): void {
  writeJson(STORAGE_KEYS.browserKeys, keys);
}
