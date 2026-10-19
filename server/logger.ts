/**
 * Logging with credential redaction.
 *
 * The backend never logs request bodies, but upstream error messages can
 * contain fragments of a key. Every secret that passes through the backend is
 * registered with the logger so it is scrubbed from all output.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** Register a secret so it is redacted from every subsequent log line. */
  registerSecret(secret: string | undefined): void;
}

const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

export function createLogger(options: { verbose?: boolean; sink?: (line: string) => void } = {}): Logger {
  const secrets = new Set<string>();
  const verbose = options.verbose ?? false;
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const redact = (value: string): string => {
    let output = value;
    for (const secret of secrets) {
      if (secret.length < 4) continue;
      output = output.split(secret).join('[redacted]');
    }
    return output.replace(BEARER_PATTERN, '$1[redacted]');
  };

  const write = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    if (level === 'debug' && !verbose) return;

    const safeMeta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta ?? {})) {
      if (/key|token|secret|authorization|password/i.test(key)) {
        safeMeta[key] = '[redacted]';
        continue;
      }
      safeMeta[key] = typeof value === 'string' ? redact(value) : value;
    }

    const suffix = Object.keys(safeMeta).length > 0 ? ` ${JSON.stringify(safeMeta)}` : '';
    sink(`[${level.toUpperCase()}] ${redact(message)}${suffix}`);
  };

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    registerSecret: (secret) => {
      if (secret && secret.length >= 4) secrets.add(secret);
    },
  };
}
