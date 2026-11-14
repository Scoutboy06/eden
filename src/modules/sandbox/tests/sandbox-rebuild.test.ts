import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import type { TransferSandboxInput } from "../provider";
import { FileSandboxSnapshotStore } from "../snapshot-store";
import { createSandboxHarness } from "./support/sandbox";

const archive = Buffer.from([0x1f, 0x8b, 0x0d, 0x0a, 0x00, 0xff]);
const input = { name: "box", force: true, snapshot: true, restore: true };

async function rebuildHarness(
  directory: string,
  options: { dryRun?: boolean; createFailure?: boolean; snapshotPaths?: boolean } = {},
) {
  const transfers: TransferSandboxInput[] = [];
  const store = new FileSandboxSnapshotStore(join(directory, "snapshots"));
  const profile =
    options.snapshotPaths === false
      ? { template: "img:1" }
      : { snapshot: { paths: ["~/.claude"] } };
  const harness = await createSandboxHarness({
    directory,
    profile: "keep",
    dryRun: options.dryRun,
    snapshotStore: store,
    config: {
      sandbox: { default_provider: "docker-sbx", profiles: { keep: profile } },
    },
    run: async (args) => {
      if (args[0] === "create" && options.createFailure) {
        return { exitCode: 1, stdout: "", stderr: "create exploded" };
      }
      const stdout =
        args[0] === "ls" ? JSON.stringify([{ name: "box", status: "running" }]) : ".claude\n";

      return { exitCode: 0, stdout, stderr: "" };
    },
    transfer: async (request) => {
      transfers.push(request);
      if (request.stdoutFile) await Bun.write(request.stdoutFile, archive);

      return { exitCode: 0, stderr: "" };
    },
  });

  return { ...harness, transfers, store };
}

test("rebuild snapshots, removes, recreates and restores in order", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, commands, transfers, store } = await rebuildHarness(directory);

    const result = await service.rebuild(input);

    const [stored] = await store.list("docker-sbx", "box");
    expect(result).toMatchObject({ restored: true, snapshot: stored });
    const steps = commands.map(({ args }) => args[0]).filter((step) => step !== "ls");
    expect(steps).toEqual(["policy", "exec", "rm", "policy", "create"]);
    expect(commands.find(({ args }) => args[0] === "rm")!.args).toEqual([
      "rm",
      "--force",
      "--",
      "box",
    ]);
    expect(transfers.map(({ stdinFile }) => stdinFile)).toEqual([undefined, stored!.path]);
  });
});

test("rebuild can skip the snapshot and the restore", async () => {
  await withTemporaryDirectory(async (directory) => {
    const skipped = await rebuildHarness(directory);

    const noSnapshot = await skipped.service.rebuild({ ...input, snapshot: false });

    expect(noSnapshot).toMatchObject({ restored: false, snapshot: undefined });
    expect(skipped.transfers).toEqual([]);

    const noRestore = await skipped.service.rebuild({ ...input, restore: false });

    expect(noRestore.restored).toBe(false);
    expect(noRestore.snapshot).toBeDefined();
    expect(skipped.transfers).toHaveLength(1);
  });
});

test("rebuild of a profile without snapshot paths just removes and recreates", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, commands, transfers } = await rebuildHarness(directory, {
      snapshotPaths: false,
    });

    const result = await service.rebuild(input);

    expect(result).toMatchObject({ restored: false, snapshot: undefined });
    expect(transfers).toEqual([]);
    expect(commands.map(({ args }) => args[0])).toContain("create");
  });
});

test("rebuild reports the removed sandbox and the kept snapshot when create fails", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, store, commands } = await rebuildHarness(directory, { createFailure: true });

    const failure = await service.rebuild(input).catch((error: unknown) => error);

    const [stored] = await store.list("docker-sbx", "box");
    expect(failure).toMatchObject({ code: "SANDBOX_REBUILD_FAILED" });
    expect((failure as Error).message).toContain(
      "Sandbox box was removed but could not be recreated",
    );
    expect((failure as Error).message).toContain(stored!.path);
    expect(commands.map(({ args }) => args[0])).toContain("rm");
  });
});

test("rebuild reports a failing create post hook as recreated, not as lost", async () => {
  await withTemporaryDirectory(async (directory) => {
    const hooks = join(directory, "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "sandbox.create.post.ts"), "process.exitCode = 3;\n");
    const { service, store, transfers } = await rebuildHarness(directory);

    const restoredFailure = await service.rebuild(input).catch((error: unknown) => error);

    const [stored] = await store.list("docker-sbx", "box");
    const restoredMessage = (restoredFailure as Error).message;
    expect(restoredFailure).toMatchObject({ code: "SANDBOX_REBUILD_FAILED" });
    expect(restoredMessage).toContain("Sandbox box was recreated but its create post hook failed");
    expect(restoredMessage).not.toContain("could not be recreated");
    expect(restoredMessage).toContain(`Its snapshot ${stored!.id} was restored.`);
    expect(transfers).toHaveLength(2);

    const skippedFailure = await service
      .rebuild({ ...input, restore: false })
      .catch((error: unknown) => error);

    const skippedMessage = (skippedFailure as Error).message;
    expect(skippedMessage).toContain("recreated but its create post hook failed");
    expect(skippedMessage).toContain("restore it with eden sbx restore --name box --snapshot");
  });
});

test("rebuild needs a profile and force for a running sandbox before touching anything", async () => {
  await withTemporaryDirectory(async (directory) => {
    const bare = await createSandboxHarness({
      directory,
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify([{ name: "box", status: "running" }]),
        stderr: "",
      }),
    });
    await expect(bare.service.rebuild(input)).rejects.toMatchObject({
      code: "SANDBOX_INVALID_INPUT",
    });

    const { service, commands, transfers } = await rebuildHarness(directory);
    await expect(service.rebuild({ ...input, force: false })).rejects.toMatchObject({
      code: "SANDBOX_REMOVE_REQUIRES_FORCE",
    });

    expect(transfers).toEqual([]);
    expect(commands.map(({ args }) => args[0])).toEqual(["ls"]);
  });
});

test("rebuild dry-run records every step without executing any", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, execution, transfers, commands } = await rebuildHarness(directory, {
      dryRun: true,
    });

    await service.rebuild(input);

    expect(execution.operations.map(({ type }) => type)).toEqual([
      "sandbox.snapshot",
      "sandbox.remove",
      "sandbox.create",
      "sandbox.restore",
    ]);
    expect(transfers).toEqual([]);
    expect(commands.map(({ args }) => args[0])).not.toContain("rm");
  });
});
