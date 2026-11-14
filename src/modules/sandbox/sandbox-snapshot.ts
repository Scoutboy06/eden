import type { Execution } from "../execution";
import type { SandboxProfile } from "../config/schema";
import { SandboxError } from "./errors";
import type { SandboxProvider } from "./provider";
import type { SandboxSnapshot, SandboxSnapshotStore } from "./snapshot-store";

export type SnapshotResult = {
  snapshot: SandboxSnapshot;
  archived: string[];
  skipped: string[];
  pruned: SandboxSnapshot[];
};

type SnapshotContext = {
  execution: Execution;
  provider: SandboxProvider;
  store: SandboxSnapshotStore;
  onWarning?: (warning: string) => void;
};

export type SnapshotSettings = NonNullable<SandboxProfile["snapshot"]>;

const defaultKeep = 5;
const probeScript =
  'cd "$HOME" && for p in "$@"; do [ -e "$p" ] && printf \'%s\n\' "$p"; done; true';
const archiveScript = 'tar -C "$HOME" -czf - -- "$@"';
const extractScript = 'tar -C "$HOME" -xzf -';

export function requireSnapshotSettings(
  profile: (SandboxProfile & { name: string }) | undefined,
): SnapshotSettings {
  if (profile?.snapshot) return profile.snapshot;

  throw new SandboxError(
    "SANDBOX_INVALID_INPUT",
    profile === undefined
      ? "Snapshots need a sandbox profile with snapshot.paths. Pass --profile or create the sandbox from a profile."
      : `Sandbox profile ${profile.name} has no snapshot.paths.`,
  );
}

export async function snapshotSandbox(
  context: SnapshotContext,
  name: string,
  settings: SnapshotSettings,
): Promise<SnapshotResult | undefined> {
  const { provider, store } = context;
  const keep = settings.keep ?? defaultKeep;
  const requested = settings.paths.map((path) => ({ path, relative: toHomeRelative(path) }));
  let result: SnapshotResult | undefined;

  await context.execution.mutate(
    {
      type: "sandbox.snapshot",
      description: `Snapshot ${settings.paths.join(", ")} of sandbox ${name} using ${provider.name}`,
      input: { provider: provider.name, name, paths: settings.paths, keep },
    },
    async () => {
      const present = await findPresentPaths(
        provider,
        name,
        requested.map(({ relative }) => relative),
      );
      const archived = requested.filter(({ relative }) => present.has(relative));
      const skipped = requested.filter(({ relative }) => !present.has(relative));

      if (archived.length === 0) {
        throw new SandboxError(
          "SANDBOX_SNAPSHOT_FAILED",
          `None of the snapshot paths exist in sandbox ${name}: ${settings.paths.join(", ")}.`,
        );
      }

      const draft = await store.begin(provider.name, name);
      let snapshot: SandboxSnapshot;

      try {
        const { exitCode, stderr } = await provider.transfer!({
          name,
          argv: ["sh", "-c", archiveScript, "sh", ...archived.map(({ relative }) => relative)],
          stdoutFile: draft.partialPath,
        });

        const tarFinished = exitCode === 0 || exitCode === 1;
        const produced = tarFinished && (await Bun.file(draft.partialPath).exists());
        const hasContent = produced && Bun.file(draft.partialPath).size > 0;
        if (!hasContent) throw transferFailure("snapshot", name, exitCode, stderr);

        if (exitCode === 1 && stderr.trim()) context.onWarning?.(stderr.trim());
        snapshot = await draft.commit();
      } catch (error) {
        await draft.discard();
        throw error;
      }

      const pruned = await store.prune(provider.name, name, keep);
      result = {
        snapshot,
        archived: archived.map(({ path }) => path),
        skipped: skipped.map(({ path }) => path),
        pruned,
      };
    },
  );

  return result;
}

export async function restoreSandbox(
  context: SnapshotContext,
  name: string,
  snapshot: SandboxSnapshot,
): Promise<void> {
  const { provider } = context;

  await context.execution.mutate(
    {
      type: "sandbox.restore",
      description: `Restore snapshot ${snapshot.id} into sandbox ${name} using ${provider.name}`,
      input: { provider: provider.name, name, snapshot: snapshot.id },
    },
    async () => {
      const { exitCode, stderr } = await provider.transfer!({
        name,
        argv: ["sh", "-c", extractScript],
        stdinFile: snapshot.path,
      });
      if (exitCode !== 0) throw transferFailure("restore", name, exitCode, stderr);
    },
  );
}

export function selectSnapshot(
  snapshots: readonly SandboxSnapshot[],
  name: string,
  requested: string,
): SandboxSnapshot {
  const snapshot =
    requested === "latest" ? snapshots[0] : snapshots.find(({ id }) => id === requested);
  if (snapshot) return snapshot;

  const reason =
    requested === "latest"
      ? `Sandbox ${name} has no snapshots.`
      : `Sandbox ${name} has no snapshot ${requested}.`;
  throw new SandboxError("SANDBOX_SNAPSHOT_NOT_FOUND", reason);
}

async function findPresentPaths(
  provider: SandboxProvider,
  name: string,
  relative: string[],
): Promise<Set<string>> {
  const result = await provider.exec!({
    name,
    argv: ["sh", "-c", probeScript, "sh", ...relative],
    output: "capture",
  });
  if (result.exitCode !== 0) {
    throw transferFailure("snapshot", name, result.exitCode, result.stderr);
  }

  return new Set(result.stdout.split(/\r?\n/).filter((line) => relative.includes(line)));
}

function toHomeRelative(path: string): string {
  return path.slice(2).replace(/\/+$/, "");
}

function transferFailure(
  action: "snapshot" | "restore",
  name: string,
  exitCode: number,
  stderr: string,
): SandboxError {
  const details = stderr.trim() ? `\n\n${stderr.trim()}` : "";

  return new SandboxError(
    "SANDBOX_SNAPSHOT_FAILED",
    `Could not ${action} sandbox ${name} (exit ${exitCode}).${details}`,
  );
}
