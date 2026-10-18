/**
 * Server configuration.
 *
 * Everything is configurable through environment variables so the backend can
 * be started in different environments without code changes.
 */

import path from 'node:path';

export interface ServerConfig {
  /** Interface the proxy binds to. Loopback by default. */
  host: string;
  port: number;
  /** Directory that holds the server side secret store. */
  dataDir: string;
  /** File that holds the server side secret store. */
  secretsFile: string;
  /**
   * Optional allow list of upstream host names. When set, requests to any
   * other host are rejected. `null` allows any host.
   */
  allowedHosts: string[] | null;
  /** Maximum accepted request body size in bytes. */
  maxBodyBytes: number;
  /** Directory with the built browser client. */
  clientDir: string;
  /** Enables verbose logging. */
  verbose: boolean;
}

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const dataDir = path.resolve(cwd, env.KAGGLE_KIT_DATA_DIR ?? '.data');
  const allowedHostsRaw = env.KAGGLE_KIT_ALLOWED_HOSTS?.trim();

  return {
    host: env.KAGGLE_KIT_HOST?.trim() || '127.0.0.1',
    port: toInt(env.KAGGLE_KIT_PORT, 8787),
    dataDir,
    secretsFile: path.join(dataDir, 'secrets.json'),
    allowedHosts: allowedHostsRaw
      ? allowedHostsRaw
          .split(',')
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean)
      : null,
    maxBodyBytes: toInt(env.KAGGLE_KIT_MAX_BODY_BYTES, 1_000_000),
    clientDir: path.resolve(cwd, env.KAGGLE_KIT_CLIENT_DIR ?? 'dist/client'),
    verbose: env.KAGGLE_KIT_VERBOSE === '1' || env.KAGGLE_KIT_VERBOSE === 'true',
  };
}
