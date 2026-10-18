/**
 * Server side secret store.
 *
 * Holds API keys for profiles that opt into the "server" credential mode.
 * The keys live in a JSON file with 0600 permissions inside a 0700 directory
 * and never reach the browser, browser storage or any log output.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

interface StoredSecret {
  apiKey: string;
  createdAt: string;
}

interface SecretFile {
  version: 1;
  secrets: Record<string, StoredSecret>;
}

export class SecretStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
  }

  private async readFile(): Promise<SecretFile> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as SecretFile;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.secrets !== 'object') {
        return { version: 1, secrets: {} };
      }
      return { version: 1, secrets: parsed.secrets ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, secrets: {} };
      }
      throw error;
    }
  }

  private async writeFile(data: SecretFile): Promise<void> {
    await this.ensureDir();
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  /** Store (or replace) a key under the given reference. */
  async set(reference: string, apiKey: string): Promise<void> {
    const data = await this.readFile();
    data.secrets[reference] = { apiKey, createdAt: new Date().toISOString() };
    await this.writeFile(data);
  }

  /** Read a key. Returns null when the reference is unknown. */
  async get(reference: string): Promise<string | null> {
    const data = await this.readFile();
    return data.secrets[reference]?.apiKey ?? null;
  }

  /** Remove a key. Returns true when something was removed. */
  async delete(reference: string): Promise<boolean> {
    const data = await this.readFile();
    if (!(reference in data.secrets)) return false;
    delete data.secrets[reference];
    await this.writeFile(data);
    return true;
  }

  /** List the known references. Never returns key material. */
  async list(): Promise<string[]> {
    const data = await this.readFile();
    return Object.keys(data.secrets);
  }

  /** Remove every stored key. */
  async clear(): Promise<void> {
    await this.writeFile({ version: 1, secrets: {} });
  }
}
