import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxProviderName } from "./provider";

export type SandboxProfileRecord = { profile: string; recordedAt: string };

export interface SandboxProfileRegistry {
  read(provider: SandboxProviderName): Promise<Record<string, SandboxProfileRecord>>;
  record(provider: SandboxProviderName, name: string, entry: SandboxProfileRecord): Promise<void>;
  forget(provider: SandboxProviderName, name: string): Promise<void>;
}

type RegistryFile = Record<string, Record<string, SandboxProfileRecord>>;

export class FileSandboxProfileRegistry implements SandboxProfileRegistry {
  constructor(private readonly path: string = defaultRegistryPath()) {}

  async read(provider: SandboxProviderName): Promise<Record<string, SandboxProfileRecord>> {
    const file = await this.load();

    return file[provider] ?? {};
  }

  async record(
    provider: SandboxProviderName,
    name: string,
    entry: SandboxProfileRecord,
  ): Promise<void> {
    const file = await this.load();
    file[provider] = { ...file[provider], [name]: entry };
    await this.save(file);
  }

  async forget(provider: SandboxProviderName, name: string): Promise<void> {
    const file = await this.load();
    const entries = file[provider];
    if (entries === undefined || !Object.hasOwn(entries, name)) return;

    const { [name]: _removed, ...remaining } = entries;
    file[provider] = remaining;
    await this.save(file);
  }

  private async load(): Promise<RegistryFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }

    return parseRegistry(text);
  }

  private async save(file: RegistryFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`);
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function defaultRegistryPath(): string {
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");

  return join(root, "eden", "sandbox-profiles.json");
}

function parseRegistry(text: string): RegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }

  const file: RegistryFile = {};
  if (!isRecord(parsed)) return file;

  for (const [provider, entries] of Object.entries(parsed)) {
    if (!isRecord(entries)) continue;
    const valid: Record<string, SandboxProfileRecord> = {};

    for (const [name, entry] of Object.entries(entries)) {
      if (!isRecord(entry) || typeof entry.profile !== "string") continue;
      if (typeof entry.recordedAt !== "string") continue;
      valid[name] = { profile: entry.profile, recordedAt: entry.recordedAt };
    }
    file[provider] = valid;
  }

  return file;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
