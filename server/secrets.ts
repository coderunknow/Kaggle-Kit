/**
 * Server-side secret and tool-profile store.
 *
 * API credentials and sanitized tool-profile configuration live in one local
 * JSON file. The directory is private (0700), the file is private (0600), and
 * neither keys nor direct credential headers are returned to the browser.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolProfileSettings } from '../shared/tools/types';
import { sanitizeToolProfileSettings } from './tools/policy';

interface StoredSecret {
  apiKey: string;
  createdAt: string;
}

interface SecretFile {
  version: 2;
  secrets: Record<string, StoredSecret>;
  toolProfiles: Record<string, ToolProfileSettings>;
}

const SECRET_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class SecretStore {
  private readonly filePath: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureDir(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  }

  private async readFile(): Promise<SecretFile> {
    await this.ensureDir();
    let raw: string;
    try {
      // Tighten permissions even when loading an existing, otherwise-valid
      // store that was created before the current secure-mode guarantee.
      await fs.chmod(this.filePath, 0o600);
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 2, secrets: {}, toolProfiles: {} };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('The local secret store contains invalid JSON; it was not overwritten.');
    }
    if (!isPlainRecord(parsed)) throw new Error('The local secret store must contain a plain JSON object.');

    if (parsed.version === 1) {
      if (!isPlainRecord(parsed.secrets)) throw new Error('The version-1 secret store has an invalid secrets record.');
      const migrated: SecretFile = {
        version: 2,
        secrets: validateSecrets(parsed.secrets),
        toolProfiles: {},
      };
      await this.writeFile(migrated);
      return migrated;
    }
    if (parsed.version !== 2) {
      throw new Error('The local secret store version is unsupported; it was not overwritten.');
    }
    if (!isPlainRecord(parsed.secrets) || !isPlainRecord(parsed.toolProfiles)) {
      throw new Error('The version-2 secret store must contain plain secrets and toolProfiles records.');
    }

    const data: SecretFile = {
      version: 2,
      secrets: validateSecrets(parsed.secrets),
      toolProfiles: validateToolProfiles(parsed.toolProfiles),
    };
    // Rewrite only when normalization removed unsafe or obsolete fields. This
    // also migrates pre-release v2 files that stored direct sensitive headers.
    if (JSON.stringify(parsed) !== JSON.stringify(data)) await this.writeFile(data);
    return data;
  }

  private async writeFile(data: SecretFile): Promise<void> {
    await this.ensureDir();
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  /** Store (or replace) a key under a safe reference. */
  async set(reference: string, apiKey: string): Promise<void> {
    if (!SECRET_REFERENCE.test(reference)) throw new Error('The key reference is invalid.');
    if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 16_384) {
      throw new Error('The API key is empty or exceeds the supported length.');
    }
    await this.runExclusive(async () => {
      const data = await this.readFile();
      data.secrets[reference] = { apiKey, createdAt: new Date().toISOString() };
      await this.writeFile(data);
    });
  }

  /** Read a key. Returns null when the reference is unknown. */
  async get(reference: string): Promise<string | null> {
    if (!SECRET_REFERENCE.test(reference)) return null;
    return this.runExclusive(async () => {
      const data = await this.readFile();
      return data.secrets[reference]?.apiKey ?? null;
    });
  }

  /** Remove a key. Returns true when something was removed. */
  async delete(reference: string): Promise<boolean> {
    if (!SECRET_REFERENCE.test(reference)) return false;
    return this.runExclusive(async () => {
      const data = await this.readFile();
      if (!(reference in data.secrets)) return false;
      delete data.secrets[reference];
      await this.writeFile(data);
      return true;
    });
  }

  /** List the known references. Never returns key material. */
  async list(): Promise<string[]> {
    return this.runExclusive(async () => {
      const data = await this.readFile();
      return Object.keys(data.secrets);
    });
  }

  /**
   * Store validated tool settings. Sensitive HTTP/MCP headers must use secret
   * references. `preserveGrantedMcpServers` is reserved for server routes that
   * have just run the explicit grant/previous-grant policy checks.
   */
  async setToolProfile(
    profileId: string,
    settings: ToolProfileSettings,
    options: { preserveGrantedMcpServers?: boolean } = {},
  ): Promise<void> {
    if (!PROFILE_ID.test(profileId)) throw new Error('The tool profile identifier is invalid.');
    await this.runExclusive(async () => {
      const data = await this.readFile();
      const sanitized = sanitizeToolProfileSettings(settings);
      if (options.preserveGrantedMcpServers) {
        const submitted = new Map(settings.mcpServers.map((server) => [server.id, server]));
        sanitized.mcpServers = sanitized.mcpServers.map((server) => {
          const candidate = submitted.get(server.id);
          const sameTarget = candidate?.transport === server.transport && candidate?.url === server.url;
          const confirmed = Boolean(sameTarget && candidate?.confirmed && candidate.enabled && server.url);
          return { ...server, confirmed, enabled: server.enabled && confirmed };
        });
      }
      data.toolProfiles[profileId] = sanitized;
      await this.writeFile(data);
    });
  }

  async getToolProfile(profileId: string): Promise<ToolProfileSettings | null> {
    if (!PROFILE_ID.test(profileId)) return null;
    return this.runExclusive(async () => {
      const data = await this.readFile();
      const settings = data.toolProfiles[profileId];
      return settings ? structuredClone(settings) : null;
    });
  }

  async deleteToolProfile(profileId: string): Promise<boolean> {
    if (!PROFILE_ID.test(profileId)) return false;
    return this.runExclusive(async () => {
      const data = await this.readFile();
      if (!(profileId in data.toolProfiles)) return false;
      delete data.toolProfiles[profileId];
      await this.writeFile(data);
      return true;
    });
  }

  /** Remove every stored key while preserving non-secret tool settings. */
  async clear(): Promise<void> {
    await this.runExclusive(async () => {
      const data = await this.readFile();
      await this.writeFile({ version: 2, secrets: {}, toolProfiles: data.toolProfiles });
    });
  }
}

function validateSecrets(raw: Record<string, unknown>): Record<string, StoredSecret> {
  const output: Record<string, StoredSecret> = Object.create(null) as Record<string, StoredSecret>;
  for (const [reference, entry] of Object.entries(raw)) {
    if (!SECRET_REFERENCE.test(reference) || !isPlainRecord(entry)) {
      throw new Error('The local secret store contains an invalid secret record.');
    }
    if (typeof entry.apiKey !== 'string' || entry.apiKey.length === 0 || entry.apiKey.length > 16_384 || typeof entry.createdAt !== 'string' || entry.createdAt.length > 64) {
      throw new Error('The local secret store contains an invalid key entry.');
    }
    output[reference] = { apiKey: entry.apiKey, createdAt: entry.createdAt };
  }
  return output;
}

function validateToolProfiles(raw: Record<string, unknown>): Record<string, ToolProfileSettings> {
  const output: Record<string, ToolProfileSettings> = Object.create(null) as Record<string, ToolProfileSettings>;
  for (const [profileId, entry] of Object.entries(raw)) {
    if (!PROFILE_ID.test(profileId) || !isPlainRecord(entry)) {
      throw new Error('The local tool-profile store contains an invalid profile record.');
    }
    let settings: ToolProfileSettings;
    try {
      settings = sanitizeToolProfileSettings(entry);
    } catch {
      throw new Error('The local tool-profile store contains invalid settings.');
    }
    // File-backed confirmation is server-owned state. Keep it only when the
    // stored target is still exactly the one the sanitized record describes.
    const sourceServers = Array.isArray(entry.mcpServers) ? entry.mcpServers : [];
    settings.mcpServers = settings.mcpServers.map((server) => {
      const source = sourceServers.find((candidate) => isPlainRecord(candidate) && candidate.id === server.id) as Record<string, unknown> | undefined;
      const sameTarget = source?.transport === server.transport && source?.url === server.url;
      const confirmed = Boolean(sameTarget && source?.confirmed === true && source.enabled === true && server.url);
      return { ...server, confirmed, enabled: server.enabled && confirmed };
    });
    output[profileId] = settings;
  }
  return output;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
