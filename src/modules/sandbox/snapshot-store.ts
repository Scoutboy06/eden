import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxProviderName } from "./provider";

export type SandboxSnapshot = {
  id: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
};

export type SnapshotDraft = {
  id: string;
  partialPath: string;
  commit(): Promise<SandboxSnapshot>;
  discard(): Promise<void>;
};

export interface SandboxSnapshotStore {
  list(provider: SandboxProviderName, name: string): Promise<SandboxSnapshot[]>;
  begin(provider: SandboxProviderName, name: string): Promise<SnapshotDraft>;
  prune(provider: SandboxProviderName, name: string, keep: number): Promise<SandboxSnapshot[]>;
}

const archiveSuffix = ".tar.gz";
const idPattern = /^\d{8}T\d{9}Z$/;

export class FileSandboxSnapshotStore implements SandboxSnapshotStore {
  constructor(private readonly root: string = defaultSnapshotRoot()) {}

  async list(provider: SandboxProviderName, name: string): Promise<SandboxSnapshot[]> {
    const directory = this.directory(provider, name);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const snapshots: SandboxSnapshot[] = [];
    for (const file of files) {
      const id = file.endsWith(archiveSuffix) ? file.slice(0, -archiveSuffix.length) : "";
      if (!idPattern.test(id)) continue;

      const path = join(directory, file);
      snapshots.push({
        id,
        path,
        createdAt: idToTimestamp(id),
        sizeBytes: (await stat(path)).size,
      });
    }

    return snapshots.sort((a, b) => b.id.localeCompare(a.id));
  }

  async begin(provider: SandboxProviderName, name: string): Promise<SnapshotDraft> {
    const directory = this.directory(provider, name);
    await mkdir(directory, { recursive: true });

    const id = timestampToId(new Date());
    const path = join(directory, `${id}${archiveSuffix}`);
    const partialPath = `${path}.partial`;

    return {
      id,
      partialPath,
      commit: async () => {
        await rename(partialPath, path);

        return { id, path, createdAt: idToTimestamp(id), sizeBytes: (await stat(path)).size };
      },
      discard: () => rm(partialPath, { force: true }),
    };
  }

  async prune(
    provider: SandboxProviderName,
    name: string,
    keep: number,
  ): Promise<SandboxSnapshot[]> {
    const expired = (await this.list(provider, name)).slice(keep);
    for (const snapshot of expired) await rm(snapshot.path, { force: true });

    return expired;
  }

  private directory(provider: SandboxProviderName, name: string): string {
    return join(this.root, provider, encodeURIComponent(name).replace(/^[.]|[.]$/gu, "%2E"));
  }
}

function defaultSnapshotRoot(): string {
  const root = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

  return join(root, "eden", "sandbox-snapshots");
}

function timestampToId(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function idToTimestamp(id: string): string {
  const [day, time] = id.split("T") as [string, string];

  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${time.slice(6, 9)}Z`;
}
