import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import type { TransferSandboxInput } from "../provider";
import { FileSandboxSnapshotStore } from "../snapshot-store";
import { createSandboxHarness } from "./support/sandbox";

const archive = Buffer.from([0x1f, 0x8b, 0x0d, 0x0a, 0x00, 0xff]);

async function snapshotHarness(
  directory: string,
  options: {
    keep?: number;
    present?: string[];
    dryRun?: boolean;
    transferExit?: number;
  } = {},
) {
  const transfers: TransferSandboxInput[] = [];
  const store = new FileSandboxSnapshotStore(join(directory, "snapshots"));
  const present = options.present ?? [".claude", ".bash_history"];
  const harness = await createSandboxHarness({
    directory,
    profile: "keep",
    dryRun: options.dryRun,
    snapshotStore: store,
    config: {
      sandbox: {
        default_provider: "docker-sbx",
        profiles: {
          keep: { snapshot: { paths: ["~/.claude", "~/.bash_history"], keep: options.keep } },
        },
      },
    },
    run: async (args) => {
      const stdout =
        args[0] === "ls"
          ? JSON.stringify([{ name: "box", status: "running" }])
          : `${present.join("\n")}\n`;

      return { exitCode: 0, stdout, stderr: "" };
    },
    transfer: async (input) => {
      transfers.push(input);
      if (input.stdoutFile) await Bun.write(input.stdoutFile, archive);

      return { exitCode: options.transferExit ?? 0, stderr: "tar: boom" };
    },
  });

  return { ...harness, transfers, store };
}

test("snapshot archives present home paths, skips missing ones and stores the bytes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, transfers, store, commands } = await snapshotHarness(directory, {
      present: [".claude"],
    });

    const result = await service.snapshot("box");

    expect(result).toMatchObject({
      archived: ["~/.claude"],
      skipped: ["~/.bash_history"],
      pruned: [],
    });
    expect(commands.map(({ args }) => args.slice(0, 3))).toEqual([
      ["ls", "--json"],
      ["exec", "--", "box"],
    ]);
    expect(transfers.map(({ argv }) => argv.slice(3))).toEqual([["sh", ".claude"]]);
    expect(transfers[0]!.argv.slice(0, 3)).toEqual(["sh", "-c", 'tar -C "$HOME" -czf - -- "$@"']);
    const [stored] = await store.list("docker-sbx", "box");
    expect(Buffer.from(await Bun.file(stored!.path).arrayBuffer())).toEqual(archive);
    expect(await service.latestSnapshot("box")).toEqual(stored);
  });
});

test("snapshot fails without leaving a file when no path exists or tar fails", async () => {
  await withTemporaryDirectory(async (directory) => {
    const empty = await snapshotHarness(directory, { present: [] });
    await expect(empty.service.snapshot("box")).rejects.toMatchObject({
      code: "SANDBOX_SNAPSHOT_FAILED",
    });

    const failing = await snapshotHarness(directory, { transferExit: 2 });
    await expect(failing.service.snapshot("box")).rejects.toThrow("tar: boom");

    expect(await failing.store.list("docker-sbx", "box")).toEqual([]);
  });
});

test("snapshot tolerates tar exit 1 and reports its output as a warning", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, warnings } = await snapshotHarness(directory, { transferExit: 1 });

    await service.snapshot("box");

    expect(warnings).toEqual(["tar: boom"]);
    expect(await service.snapshots("box")).toHaveLength(1);
  });
});

test("snapshot prunes to the profile keep count, newest first", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service } = await snapshotHarness(directory, { keep: 2 });

    const first = await service.snapshot("box");
    await Bun.sleep(5);
    await service.snapshot("box");
    await Bun.sleep(5);
    const third = await service.snapshot("box");

    const remaining = await service.snapshots("box");
    expect(remaining).toHaveLength(2);
    expect(remaining[0]!.id).toBe(third!.snapshot.id);
    expect(third!.pruned.map(({ id }) => id)).toEqual([first!.snapshot.id]);
  });
});

test("snapshot dry-run records the operation without touching the sandbox or store", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, execution, transfers, commands } = await snapshotHarness(directory, {
      dryRun: true,
    });

    expect(await service.snapshot("box")).toBeUndefined();

    expect(execution.operations).toMatchObject([
      { type: "sandbox.snapshot", input: { name: "box", paths: ["~/.claude", "~/.bash_history"] } },
    ]);
    expect(transfers).toEqual([]);
    expect(commands.map(({ args }) => args[0])).toEqual(["ls"]);
  });
});

test("snapshot requires a profile with snapshot paths", async () => {
  await withTemporaryDirectory(async (directory) => {
    const none = await createSandboxHarness({ directory });
    await expect(none.service.snapshot("box")).rejects.toMatchObject({
      code: "SANDBOX_INVALID_INPUT",
    });

    const bare = await createSandboxHarness({
      directory,
      profile: "bare",
      config: { sandbox: { default_provider: "docker-sbx", profiles: { bare: {} } } },
    });
    await expect(bare.service.snapshot("box")).rejects.toThrow(
      "Sandbox profile bare has no snapshot.paths",
    );
  });
});

test("restore streams the chosen snapshot back and rejects unknown ids", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, transfers } = await snapshotHarness(directory);
    const first = await service.snapshot("box");
    await Bun.sleep(5);
    await service.snapshot("box");

    const restored = await service.restore("box", first!.snapshot.id);

    expect(restored.snapshot.id).toBe(first!.snapshot.id);
    expect(transfers.at(-1)).toEqual({
      name: "box",
      argv: ["sh", "-c", 'tar -C "$HOME" -xzf -'],
      stdinFile: first!.snapshot.path,
    });
    await expect(service.restore("box", "nope")).rejects.toMatchObject({
      code: "SANDBOX_SNAPSHOT_NOT_FOUND",
    });
  });
});

test("restore picks latest by default and reports a sandbox without snapshots", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, transfers, execution } = await snapshotHarness(directory);
    await expect(service.restore("box")).rejects.toMatchObject({
      code: "SANDBOX_SNAPSHOT_NOT_FOUND",
    });

    await service.snapshot("box");
    await Bun.sleep(5);
    const latest = await service.snapshot("box");
    await service.restore("box");

    expect(transfers.at(-1)!.stdinFile).toBe(latest!.snapshot.path);
    expect(execution.operations.at(-1)).toMatchObject({ type: "sandbox.restore" });
  });
});

test("restore dry-run does not transfer", async () => {
  await withTemporaryDirectory(async (directory) => {
    const live = await snapshotHarness(directory);
    await live.service.snapshot("box");
    const dry = await snapshotHarness(directory, { dryRun: true });

    await dry.service.restore("box");

    expect(dry.transfers).toEqual([]);
    expect(dry.execution.operations).toMatchObject([{ type: "sandbox.restore" }]);
  });
});

test("snapshots of a sandbox name that looks like a path stay inside the store", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new FileSandboxSnapshotStore(join(directory, "snapshots"));

    for (const name of ["..", ".", "../escape", "a/b"]) {
      const draft = await store.begin("docker-sbx", name);
      await Bun.write(draft.partialPath, archive);
      const snapshot = await draft.commit();

      expect(snapshot.path.startsWith(join(directory, "snapshots", "docker-sbx"))).toBe(true);
      expect(await store.list("docker-sbx", name)).toEqual([snapshot]);
    }
  });
});
