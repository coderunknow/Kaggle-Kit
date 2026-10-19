/**
 * Error classification and secret redaction.
 *
 * The chat UI needs to tell the user *what* went wrong: a wrong API key, a
 * wrong base URL, a missing model, a blocked request (CORS/proxy), a timeout
 * or a failing upstream all need different advice. `ApiError` carries that
 * classification, and every message that leaves this module is scrubbed of
 * credentials.
 */

export type ApiErrorKind =
  | 'network'
  | 'cors_or_proxy'
  | 'timeout'
  | 'aborted'
  | 'auth'
  | 'not_found'
  | 'bad_request'
  | 'server'
  | 'invalid_response'
  | 'inference'
  | 'unknown';

/** Kinds that are caused by the user's configuration rather than the server. */
const CONFIGURATION_KINDS: ReadonlySet<ApiErrorKind> = new Set<ApiErrorKind>([
  'auth',
  'not_found',
  'bad_request',
  'cors_or_proxy',
]);

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly httpStatus?: number;
  readonly detail?: string;
  /** Actionable hint rendered next to the message in the UI. */
  readonly hint?: string;

  constructor(
    kind: ApiErrorKind,
    message: string,
    options: { httpStatus?: number; detail?: string; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ApiError';
    this.kind = kind;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.hint !== undefined) this.hint = options.hint;
  }

  /** True when the failure is caused by the user's configuration. */
  get isConfigurationError(): boolean {
    return CONFIGURATION_KINDS.has(this.kind);
  }
}

const KIND_HINTS: Record<ApiErrorKind, string> = {
  network:
    'The request never reached the server. Check that the server is running and that this device can reach the host.',
  cors_or_proxy:
    'The browser or proxy blocked the request. Make sure the API is reached through the local proxy and that no CORS policy blocks it.',
  timeout: 'The server did not answer in time. Increase the request timeout or reduce the workload.',
  aborted: 'The request was cancelled.',
  auth: 'The server rejected the API key. Check the key and restart the server if it was rotated.',
  not_found: 'The endpoint or model was not found. Check the base URL and the model ID.',
  bad_request: 'The server rejected the request payload. Check the model ID and the inference settings.',
  server: 'The server failed while handling the request. Check the server log for details.',
  invalid_response: 'The server replied with something that is not a valid OpenAI-compatible response.',
  inference: 'The server accepted the request but could not produce a completion.',
  unknown: 'The request failed for an unknown reason.',
};

/** Attach the standard hint for a kind, unless a specific one was supplied. */
export function withHint(kind: ApiErrorKind, hint?: string): string | undefined {
  return hint ?? KIND_HINTS[kind];
}

export function classifyHttpStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 400 || status === 422) return 'bad_request';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * Remove secrets from a string. Used for every message that may contain
 * server output (error bodies, log lines) before it reaches the UI or a log
 * file.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    output = output.split(secret).join('[redacted]');
  }
  // Belt and braces: never echo a bearer token even if it was transformed.
  output = output.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]');
  return output;
}

/** Human readable label for an error kind, used in the UI. */
export function describeErrorKind(kind: ApiErrorKind): string {
  switch (kind) {
    case 'network':
      return 'Connection failed';
    case 'cors_or_proxy':
      return 'Blocked by CORS or proxy';
    case 'timeout':
      return 'Request timed out';
    case 'aborted':
      return 'Request cancelled';
    case 'auth':
      return 'Authentication failed';
    case 'not_found':
      return 'Not found';
    case 'bad_request':
      return 'Invalid request';
    case 'server':
      return 'Server error';
    case 'invalid_response':
      return 'Invalid response';
    case 'inference':
      return 'Inference failed';
    default:
      return 'Request failed';
  }
}
