import { expect, test } from "bun:test";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

const archiveHex = "1f8b0d0a00ff1a0a0d80";

async function prepareRebuildCli(directory: string, mode: string) {
  const options = await prepareSandboxCli(directory, mode);
  await Bun.write(
    join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
    stringify({
      sandbox: {
        default_provider: "docker-sbx",
        profiles: { plain: {}, keep: { snapshot: { paths: ["~/.claude"] } } },
      },
    }),
  );
  options.env.XDG_DATA_HOME = join(directory, "data");

  return options;
}

test("rebuild removes and recreates the sandbox from the profile", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareRebuildCli(directory, "running");

    const result = await runCliWith(
      options,
      "sbx",
      "rebuild",
      "--name",
      "example",
      "--profile",
      "plain",
      "--force",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      sandbox: { name: "example" },
      restored: false,
    });
    const steps = (await sandboxCommands(directory)).map((args) => args[0]);
    expect(steps.indexOf("rm")).toBeLessThan(steps.indexOf("create"));
  });
});

test("rebuild asks for force without a terminal and for a profile when none is known", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareRebuildCli(directory, "running");

    const unforced = await runCliWith(options, "sbx", "rebuild", "--name", "example", "--json");

    expect(JSON.parse(unforced.stdout).error.code).toBe("SANDBOX_REMOVE_REQUIRES_FORCE");

    const profileless = await runCliWith(
      options,
      "sbx",
      "rebuild",
      "--name",
      "example",
      "--force",
      "--json",
    );

    expect(JSON.parse(profileless.stdout).error).toMatchObject({
      code: "SANDBOX_INVALID_INPUT",
      message: expect.stringContaining("--profile"),
    });
    expect((await sandboxCommands(directory)).map((args) => args[0])).not.toContain("rm");
  });
});

test("rebuild reports the removed sandbox when the recreate fails", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareRebuildCli(directory, "running");
    options.env.EDEN_SBX_CREATE_FAILURE = "boom";

    const result = await runCliWith(
      options,
      "sbx",
      "rebuild",
      "--name",
      "example",
      "--profile",
      "plain",
      "--force",
      "--json",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "SANDBOX_REBUILD_FAILED",
      message: expect.stringContaining("Sandbox example was removed but could not be recreated"),
    });
  });
});

test("rebuild dry-run lists every step and runs none", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareRebuildCli(directory, "stopped");

    const result = await runCliWith(
      options,
      "sbx",
      "rebuild",
      "--name",
      "example",
      "--profile",
      "keep",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).operations.map(({ type }: { type: string }) => type)).toEqual([
      "sandbox.snapshot",
      "sandbox.remove",
      "sandbox.create",
      "sandbox.restore",
    ]);
    expect((await sandboxCommands(directory)).map((args) => args[0])).not.toContain("rm");
  });
});

test.skipIf(process.platform === "win32")(
  "rebuild carries the snapshot paths over to the recreated sandbox",
  async () => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareRebuildCli(directory, "snapshot");
      options.env.EDEN_SBX_PRESENT = JSON.stringify([".claude"]);
      options.env.EDEN_SBX_ARCHIVE_HEX = archiveHex;
      options.env.EDEN_SBX_RESTORE_OUT = join(directory, "restored.bin");

      const result = await runCliWith(
        options,
        "sbx",
        "rebuild",
        "--name",
        "example",
        "--profile",
        "keep",
        "--force",
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).restored).toBe(true);
      expect(
        Buffer.from(await Bun.file(options.env.EDEN_SBX_RESTORE_OUT!).arrayBuffer()).toString(
          "hex",
        ),
      ).toBe(archiveHex);
    });
  },
);
