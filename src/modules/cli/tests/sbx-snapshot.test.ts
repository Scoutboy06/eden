import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

const archiveHex = "1f8b0d0a00ff1a0a0d80";

async function prepareSnapshotCli(directory: string) {
  const options = await prepareSandboxCli(directory, "running");
  await writeFile(
    join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
    stringify({
      sandbox: {
        default_provider: "docker-sbx",
        profiles: { keep: { snapshot: { paths: ["~/.claude", "~/.gone"], keep: 2 } } },
      },
    }),
  );
  options.env.XDG_DATA_HOME = join(directory, "data");
  options.env.EDEN_SBX_RUN_MODE = "running";
  const created = await runCliWith(
    options,
    "sbx",
    "create",
    "--name",
    "example",
    "--profile",
    "keep",
  );
  expect(created.exitCode).toBe(0);
  options.env.EDEN_SBX_RUN_MODE = "snapshot";
  options.env.EDEN_SBX_PRESENT = JSON.stringify([".claude"]);
  options.env.EDEN_SBX_ARCHIVE_HEX = archiveHex;
  options.env.EDEN_SBX_RESTORE_OUT = join(directory, "restored.bin");

  return options;
}

test.skipIf(process.platform === "win32")(
  "snapshot, list and restore round trip bytes using the remembered profile",
  async () => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSnapshotCli(directory);

      const taken = await runCliWith(options, "sbx", "snapshot", "--name", "example", "--json");

      expect(taken.exitCode).toBe(0);
      const { snapshot, archived, skipped } = JSON.parse(taken.stdout);
      expect({ archived, skipped }).toEqual({ archived: ["~/.claude"], skipped: ["~/.gone"] });
      expect(Buffer.from(await Bun.file(snapshot.path).arrayBuffer()).toString("hex")).toBe(
        archiveHex,
      );

      const listed = await runCliWith(
        options,
        "sbx",
        "snapshot",
        "--list",
        "--name",
        "example",
        "--json",
      );
      expect(JSON.parse(listed.stdout).snapshots).toEqual([snapshot]);

      const restored = await runCliWith(options, "sbx", "restore", "--name", "example", "--json");

      expect(restored.exitCode).toBe(0);
      expect(JSON.parse(restored.stdout).snapshot.id).toBe(snapshot.id);
      expect(
        Buffer.from(await Bun.file(options.env.EDEN_SBX_RESTORE_OUT!).arrayBuffer()).toString(
          "hex",
        ),
      ).toBe(archiveHex);
    });
  },
);

test("snapshot and restore dry-run run nothing in the sandbox", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSnapshotCli(directory);
    const stored = join(directory, "data", "eden", "sandbox-snapshots", "docker-sbx", "example");
    await mkdir(stored, { recursive: true });
    await Bun.write(join(stored, "20261114T100000000Z.tar.gz"), Buffer.from(archiveHex, "hex"));
    const before = (await sandboxCommands(directory)).length;

    const snapshot = await runCliWith(
      options,
      "sbx",
      "snapshot",
      "--name",
      "example",
      "--dry-run",
      "--json",
    );
    const restore = await runCliWith(
      options,
      "sbx",
      "restore",
      "--name",
      "example",
      "--dry-run",
      "--json",
    );

    expect(JSON.parse(snapshot.stdout)).toMatchObject({
      dryRun: true,
      operations: [{ type: "sandbox.snapshot" }],
    });
    expect(JSON.parse(restore.stdout)).toMatchObject({
      dryRun: true,
      operations: [{ type: "sandbox.restore" }],
    });
    const commands = (await sandboxCommands(directory)).slice(before);
    expect(commands.every((command) => command[0] === "ls")).toBe(true);
    expect(await Bun.file(options.env.EDEN_SBX_RESTORE_OUT!).exists()).toBe(false);
  });
});

test("snapshot of a sandbox without a snapshot profile explains what to do", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");

    const result = await runCliWith(options, "sbx", "snapshot", "--name", "example", "--json");

    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "SANDBOX_INVALID_INPUT", message: expect.stringContaining("--profile") },
    });
  });
});
