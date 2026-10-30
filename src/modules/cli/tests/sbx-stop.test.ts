import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith, withRunningCli } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.each(["running", "stopped"])(
  "stop succeeds for a %s sandbox with JSON identity",
  async (status) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, status);

      const result = await runCliWith(options, "sbx", "stop", "--name", "example", "--json");

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        dryRun: false,
        sandbox: { provider: "docker-sbx", name: "example" },
      });
      expect(await sandboxCommands(directory)).toEqual([
        ["ls", "--format", "json"],
        ...(status === "stopped" ? [] : [["stop", "--", "example"]]),
      ]);
    });
  },
);

test("stop presents a human result and accepts an explicit provider", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");
    await Bun.write(join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"), "invalid: [");

    const result = await runCliWith(
      options,
      "sbx",
      "stop",
      "--provider",
      "docker-sbx",
      "--name",
      "example",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Sandbox example is stopped using docker-sbx.");
    expect(result.stdout).toContain("Its data is preserved.");
  });
});

test.each([false, true])(
  "stop dry-run reports the operation without mutation, json=%s",
  async (json) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "running");

      const result = await runCliWith(
        options,
        "sbx",
        "stop",
        "--name",
        "example",
        "--dry-run",
        ...(json ? ["--json"] : []),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      if (json) {
        expect(JSON.parse(result.stdout)).toEqual({
          ok: true,
          dryRun: true,
          operations: [
            {
              type: "sandbox.stop",
              description: "Stop sandbox example using docker-sbx",
              input: { provider: "docker-sbx", name: "example" },
            },
          ],
        });
      } else expect(result.stdout).toBe("[dry-run] Stop sandbox example using docker-sbx\n");
      expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
    });
  },
);

test.each([false, true])("stop rejects a nonexistent sandbox, dryRun=%s", async (dryRun) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");

    const result = await runCliWith(
      options,
      "sbx",
      "stop",
      "--name",
      "example",
      "--json",
      ...(dryRun ? ["--dry-run"] : []),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "SANDBOX_NOT_FOUND",
        message: "Sandbox example was not found using docker-sbx.",
      },
    });
    expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
  });
});

test.each([{ args: [] }, { args: ["--name", ""] }, { args: ["--name", "   "] }])(
  "stop requires a nonempty name: %j",
  async ({ args }) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "running");

      const result = await runCliWith(options, "sbx", "stop", ...args, "--json");

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
      expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
    });
  },
);

test("stop preserves provider diagnostics in a structured failure", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");
    options.env.EDEN_SBX_STOP_FAILURE = "stop provider failure";

    const result = await runCliWith(options, "sbx", "stop", "--name", "example", "--json");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "SANDBOX_STOP_FAILED" },
    });
    expect(JSON.parse(result.stdout).error.message).toContain("stop provider failure");
    expect(await sandboxCommands(directory)).toEqual([
      ["ls", "--format", "json"],
      ["stop", "--", "example"],
    ]);
  });
});

test.skipIf(process.platform === "win32")(
  "stop cancellation reports CANCELLED without cleanup",
  async () => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "interrupt");

      await withRunningCli(options, ["sbx", "stop", "--name", "example", "--json"], async (cli) => {
        await cli.waitForReady(options.env.EDEN_SBX_RUN_READY!);

        cli.interrupt();
        const result = await cli.result;

        expect(result.exitCode).toBe(130);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { code: "CANCELLED" },
        });
        expect(JSON.parse(result.stdout).error.message).toContain(
          "no removal or cleanup was attempted",
        );
        expect(await sandboxCommands(directory)).toEqual([
          ["ls", "--format", "json"],
          ["stop", "--", "example"],
        ]);
      });
    });
  },
);
