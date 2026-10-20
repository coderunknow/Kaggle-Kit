/**
 * Validation helpers shared by the settings UI and the proxy backend.
 *
 * The backend validates every request with the same code the browser uses, so
 * an invalid value can never reach the model server.
 */

import { DEFAULT_INFERENCE_PARAMS, type InferenceParams, type ReasoningEffort } from './requests';
import { UrlValidationError, normalizeBaseUrlDetailed } from './url';

export const LIMITS = {
  maxTokens: { min: 1, max: 32768, default: DEFAULT_INFERENCE_PARAMS.maxTokens },
  temperature: { min: 0, max: 2, default: DEFAULT_INFERENCE_PARAMS.temperature },
  topP: { min: 0, max: 1, default: DEFAULT_INFERENCE_PARAMS.topP },
  frequencyPenalty: { min: -2, max: 2 },
  presencePenalty: { min: -2, max: 2 },
  timeoutMs: { min: 1_000, max: 1_800_000, default: 120_000 },
} as const;

export const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export interface ParsedParams {
  params: InferenceParams;
  issues: string[];
}

/** Parse and clamp inference parameters coming from an untrusted source. */
export function parseInferenceParams(raw: unknown): ParsedParams {
  const issues: string[] = [];
  const source = (raw ?? {}) as Record<string, unknown>;

  const maxTokensRaw = toFiniteNumber(source.maxTokens);
  const maxTokens = clamp(
    maxTokensRaw ?? LIMITS.maxTokens.default,
    LIMITS.maxTokens.min,
    LIMITS.maxTokens.max,
  );
  if (maxTokensRaw !== undefined && maxTokensRaw !== maxTokens) {
    issues.push(`max_tokens was clamped to ${maxTokens}.`);
  }

  const temperatureRaw = toFiniteNumber(source.temperature);
  const temperature = clamp(
    temperatureRaw ?? LIMITS.temperature.default,
    LIMITS.temperature.min,
    LIMITS.temperature.max,
  );
  if (temperatureRaw !== undefined && temperatureRaw !== temperature) {
    issues.push(`temperature was clamped to ${temperature}.`);
  }

  const topPRaw = toFiniteNumber(source.topP);
  const topP = clamp(topPRaw ?? LIMITS.topP.default, LIMITS.topP.min, LIMITS.topP.max);
  if (topPRaw !== undefined && topPRaw !== topP) {
    issues.push(`top_p was clamped to ${topP}.`);
  }

  const frequencyRaw = toFiniteNumber(source.frequencyPenalty);
  const presenceRaw = toFiniteNumber(source.presencePenalty);

  const reasoningRaw = source.reasoningEffort;
  let reasoningEffort: ReasoningEffort | null = null;
  if (typeof reasoningRaw === 'string' && reasoningRaw.length > 0) {
    if (REASONING_EFFORTS.includes(reasoningRaw as ReasoningEffort)) {
      reasoningEffort = reasoningRaw as ReasoningEffort;
    } else {
      issues.push(`reasoning_effort "${reasoningRaw}" is unknown and was ignored.`);
    }
  }

  return {
    params: {
      maxTokens,
      temperature,
      topP,
      frequencyPenalty: frequencyRaw === undefined ? undefined : clamp(frequencyRaw, LIMITS.frequencyPenalty.min, LIMITS.frequencyPenalty.max),
      presencePenalty: presenceRaw === undefined ? undefined : clamp(presenceRaw, LIMITS.presencePenalty.min, LIMITS.presencePenalty.max),
      reasoningEffort,
      stream: source.stream === true,
    },
    issues,
  };
}

export interface ProfileDraft {
  name: string;
  baseUrl: string;
  modelId: string;
  systemPrompt: string;
  timeoutMs: number;
  credentialStorage: 'session' | 'server' | 'browser';
}

export interface ProfileValidation {
  ok: boolean;
  errors: Record<string, string>;
  /** Normalized base URL, present when the value is valid. */
  normalizedBaseUrl?: string;
  notes: string[];
}

/** Validate the profile form. Returns per field messages for the UI. */
export function validateProfileDraft(draft: ProfileDraft): ProfileValidation {
  const errors: Record<string, string> = {};
  const notes: string[] = [];

  if (!draft.name.trim()) {
    errors.name = 'Give the profile a name.';
  }

  let normalizedBaseUrl: string | undefined;
  try {
    const result = normalizeBaseUrlDetailed(draft.baseUrl);
    normalizedBaseUrl = result.baseUrl;
    notes.push(...result.notes);
  } catch (error) {
    errors.baseUrl =
      error instanceof UrlValidationError ? error.message : 'The base URL is not valid.';
  }

  const timeout = toFiniteNumber(draft.timeoutMs);
  if (timeout === undefined) {
    errors.timeoutMs = 'Enter a timeout in milliseconds.';
  } else if (timeout < LIMITS.timeoutMs.min || timeout > LIMITS.timeoutMs.max) {
    errors.timeoutMs = `Use a timeout between ${LIMITS.timeoutMs.min} and ${LIMITS.timeoutMs.max} ms.`;
  }

  return { ok: Object.keys(errors).length === 0, errors, normalizedBaseUrl, notes };
}
