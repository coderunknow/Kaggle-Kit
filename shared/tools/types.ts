/** Shared, serializable tool settings and trace metadata. Secrets are references only. */

import type { JsonSchema, OpenAIToolDefinition } from '../api/types';

export type ToolCapabilityStatus =
  | 'supported_verified'
  | 'unsupported'
  | 'not_verified'
  | 'temporarily_unavailable'
  | 'failed_verification';

export interface ToolCallingCapability {
  status: ToolCapabilityStatus;
  detail: string;
  checkedAt?: string;
  model?: string;
  /** Native streaming tool-call deltas were independently probed. */
  streamingSupported?: boolean;
  /** Turn 1 of the probe returned a native `tool_calls` response. */
  protocolVerified?: boolean;
  /** Turn 2 accepted the synthetic tool result and answered with a final stop. */
  roundTripVerified?: boolean;
  /** Hash-like identity of the endpoint/model/credential configuration; never a secret. */
  configurationFingerprint?: string;
}

/**
 * Why a tool call failed, for truthful trace diagnostics. The kind never
 * re-enables a denied or unapproved operation; it only describes the failure.
 */
export type ToolFailureKind =
  | 'invalid_tool_name'
  | 'invalid_arguments'
  | 'approval_required'
  | 'approval_denied'
  | 'approval_expired'
  | 'timeout'
  | 'execution_error'
  | 'budget_exceeded'
  | 'cancelled';

export type ToolPermission = 'read_only' | 'write' | 'unknown';

export interface ToolExecutionLimits {
  maxRounds: number;
  maxCalls: number;
  perToolTimeoutMs: number;
  loopTimeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}

export interface HttpHeaderSetting {
  name: string;
  /** Non-sensitive fixed header value. Never model-controlled. */
  value?: string;
  /** Reference to a secret in the local proxy's protected secret store. */
  secretRef?: string;
}

export interface HttpToolSetting {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  inputSchema: JsonSchema;
  headers: HttpHeaderSetting[];
  permission: ToolPermission;
  timeoutMs: number;
  /** Optional RFC 6901 JSON Pointer applied to JSON responses. */
  responsePointer?: string;
}

export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  selected: boolean;
  permission: ToolPermission;
  /** Original server name; unique within a configured connection. */
  serverToolName: string;
}

export interface McpServerSetting {
  id: string;
  name: string;
  transport: 'streamable_http' | 'stdio';
  enabled: boolean;
  confirmed: boolean;
  /** Remote MCP endpoint; never contains credentials. */
  url?: string;
  /** Local stdio executable. It must be an absolute path. No shell is used. */
  command?: string;
  args?: string[];
  cwd?: string;
  /** Secret references only; resolved by the local proxy. */
  headers?: HttpHeaderSetting[];
  environment?: Record<string, string | { secretRef: string }>;
  timeoutMs: number;
  tools: McpDiscoveredTool[];
}

export interface CodeSandboxSettings {
  provider: 'docker' | 'disabled';
  /** Python-only trusted image selection. No image is pulled automatically. */
  image: string;
  isolation: 'strict';
  network: 'none';
  timeoutMs: number;
  memoryMb: number;
  cpuCores: number;
  maxProcesses: number;
  outputBytes: number;
}

export interface WebProviderSettings {
  provider: 'brave' | 'disabled';
  /** Reference to a Brave Search API key in the proxy secret store. */
  secretRef?: string;
  /** Required to persist provider result material when the configured plan allows it. */
  storageRightsConfirmed?: boolean;
}

export interface ToolProfileSettings {
  enabled: boolean;
  allowedTools: string[];
  limits: ToolExecutionLimits;
  historyPersistence: boolean;
  web: WebProviderSettings;
  httpTools: HttpToolSetting[];
  mcpServers: McpServerSetting[];
  code: CodeSandboxSettings;
}

export interface ConversationToolSettings {
  /** Conversation may disable profile tools but cannot enable profile-disabled tools. */
  enabled?: boolean;
  /** Selection is always intersected with the active profile's allowlist. */
  toolIds?: string[];
  /** Conversation-level limits can only tighten profile limits. */
  maxRounds?: number;
  maxCalls?: number;
  loopTimeoutMs?: number;
  historyPersistence?: boolean;
  /**
   * Opt-in bounded selection recovery: when the first model round of a turn
   * answers with plain text and no tool ran yet, the server may spend one
   * corrective round asking the model to call a tool only if the request
   * actually needs one. The model may still answer directly; recovery never
   * forces a tool call and never bypasses approvals or denials. Off by
   * default so ordinary questions do not pay for an extra round.
   */
  selectionRecovery?: boolean;
}

/** What the bounded corrective-recovery policy did during one tool job. */
export interface ToolRecoveryRecord {
  /** Corrective rounds or corrective error feedbacks spent in this job. */
  attempts: number;
  outcome: 'not_needed' | 'corrected' | 'failed';
  /** Short, secret-free, human-readable evidence of every recovery event. */
  events: string[];
}

export type ToolCallStatus =
  | 'requested'
  | 'awaiting_approval'
  | 'approved'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'interrupted';

export interface SourceCitation {
  url: string;
  title?: string;
  publisher?: string;
  retrievedAt?: string;
}

export interface ToolTraceRecord {
  id: string;
  /**
   * The correlation ID the model issued for this call, when it was valid.
   * The trace `id` above is always a server-generated UUID; the two are
   * distinct and must never be conflated.
   */
  callId?: string;
  toolName: string;
  status: ToolCallStatus;
  approvalRequired: boolean;
  approvalState?: 'not_required' | 'pending' | 'approved' | 'denied' | 'expired' | 'stale';
  /** Structured failure reason; never contains secrets. */
  failureKind?: ToolFailureKind;
  /** Redacted/bounded copy of the validated arguments; never contains secrets. */
  safeArguments: Record<string, unknown>;
  /** User-facing operation target when known; credentials are never included. */
  target?: string;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  resultSummary?: string;
  error?: string;
  citations?: SourceCitation[];
  /** Server-issued, short-lived identifier used only while a call awaits the user. */
  approvalId?: string;
}

export interface UploadedFileReference {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  extractedCharacters: number;
  truncated?: boolean;
}

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  summary: string;
  citations?: SourceCitation[];
}

export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON string exactly as returned by the model. */
    arguments: string;
  };
}

export interface ToolDefinition extends OpenAIToolDefinition {
  /** Local-only UI/permission metadata; stripped before sending upstream. */
  permission: ToolPermission;
  requiresApproval?: boolean;
  targetLabel?: string;
}

export const DEFAULT_TOOL_LIMITS: ToolExecutionLimits = {
  maxRounds: 3,
  maxCalls: 8,
  perToolTimeoutMs: 15_000,
  loopTimeoutMs: 120_000,
  maxInputBytes: 8_192,
  maxOutputBytes: 24_000,
};

export const HARD_TOOL_LIMITS: ToolExecutionLimits = {
  maxRounds: 8,
  maxCalls: 24,
  perToolTimeoutMs: 60_000,
  loopTimeoutMs: 300_000,
  maxInputBytes: 32_768,
  maxOutputBytes: 64_000,
};

export const DEFAULT_CODE_SANDBOX: CodeSandboxSettings = {
  provider: 'disabled',
  image: 'python:3.12-alpine',
  isolation: 'strict',
  network: 'none',
  timeoutMs: 10_000,
  memoryMb: 128,
  cpuCores: 0.5,
  maxProcesses: 32,
  outputBytes: 8_192,
};

export const DEFAULT_TOOL_PROFILE_SETTINGS: ToolProfileSettings = {
  enabled: false,
  allowedTools: [],
  limits: { ...DEFAULT_TOOL_LIMITS },
  historyPersistence: false,
  web: { provider: 'disabled' },
  httpTools: [],
  mcpServers: [],
  code: { ...DEFAULT_CODE_SANDBOX },
};

export function clampToolLimits(limits: Partial<ToolExecutionLimits> | undefined): ToolExecutionLimits {
  const raw = limits ?? {};
  const bounded = (key: keyof ToolExecutionLimits, fallback: number) => {
    const value = raw[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(1, Math.min(HARD_TOOL_LIMITS[key], Math.floor(value)))
      : fallback;
  };
  return {
    maxRounds: bounded('maxRounds', DEFAULT_TOOL_LIMITS.maxRounds),
    maxCalls: bounded('maxCalls', DEFAULT_TOOL_LIMITS.maxCalls),
    perToolTimeoutMs: bounded('perToolTimeoutMs', DEFAULT_TOOL_LIMITS.perToolTimeoutMs),
    loopTimeoutMs: bounded('loopTimeoutMs', DEFAULT_TOOL_LIMITS.loopTimeoutMs),
    maxInputBytes: bounded('maxInputBytes', DEFAULT_TOOL_LIMITS.maxInputBytes),
    maxOutputBytes: bounded('maxOutputBytes', DEFAULT_TOOL_LIMITS.maxOutputBytes),
  };
}

export function mergeConversationLimits(
  profile: ToolExecutionLimits,
  conversation?: ConversationToolSettings,
): ToolExecutionLimits {
  const requested = conversation ?? {};
  return {
    maxRounds: Math.min(profile.maxRounds, positive(requested.maxRounds, profile.maxRounds)),
    maxCalls: Math.min(profile.maxCalls, positive(requested.maxCalls, profile.maxCalls)),
    perToolTimeoutMs: profile.perToolTimeoutMs,
    loopTimeoutMs: Math.min(profile.loopTimeoutMs, positive(requested.loopTimeoutMs, profile.loopTimeoutMs)),
    maxInputBytes: profile.maxInputBytes,
    maxOutputBytes: profile.maxOutputBytes,
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function shouldPersistToolHistory(
  profile: ToolProfileSettings,
  conversation?: ConversationToolSettings,
): boolean {
  const requested = conversation?.historyPersistence ?? profile.historyPersistence;
  // Brave's current standard result terms restrict retention. The app stays
  // transient unless the user confirms their account plan grants persistence.
  return Boolean(requested && (profile.web.provider !== 'brave' || profile.web.storageRightsConfirmed));
}

export function effectiveToolSelection(
  profile: ToolProfileSettings,
  conversation?: ConversationToolSettings,
): string[] {
  if (!profile.enabled || conversation?.enabled === false) return [];
  const profileAllowed = new Set(profile.allowedTools);
  if (!conversation?.toolIds) return [...profileAllowed];
  const conversationAllowed = new Set(conversation.toolIds);
  return [...profileAllowed].filter((toolId) => conversationAllowed.has(toolId));
}
