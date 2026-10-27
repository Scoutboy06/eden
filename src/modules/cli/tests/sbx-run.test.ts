import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith, withRunningCli } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

const application = fileURLToPath(new URL("../../../../apps/cli/src/main.ts", import.meta.url));

test.each(["running", "stopped", "failure"])(
  "run attaches with provider output and exit status: %s",
  async (mode) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, mode, "name with ' quotes");

      const result = await runCliWith(options, "sbx", "run", "--name", "name with ' quotes");

      expect(result).toEqual({
        exitCode: mode === "failure" ? 7 : 0,
        stdout: "attached\n",
        stderr: "provider stderr\n",
      });
      expect(await sandboxCommands(directory)).toEqual([
        ["ls", "--format", "json"],
        ["run", "--name", "name with ' quotes"],
      ]);
    });
  },
);

test.each(["missing", "malformed"])("run refuses %s listing without attachment", async (mode) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, mode);

    const result = await runCliWith(options, "sbx", "run", "--name", "example");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      mode === "missing" ? "does not exist" : "invalid sandbox listing JSON",
    );
    expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
  });
});

test("run JSON dry-run checks existence and reports attachment without launching it", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "stopped");

    const result = await runCliWith(
      options,
      "sbx",
      "run",
      "--name",
      "example",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      dryRun: true,
      operations: [
        {
          type: "sandbox.run",
          description: "Attach to sandbox example using docker-sbx",
          input: { provider: "docker-sbx", name: "example" },
        },
      ],
    });
    expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
  });
});

test("run rejects JSON before contacting the provider", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");

    const result = await runCliWith(options, "sbx", "run", "--name", "example", "--json");

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "SANDBOX_INVALID_INPUT" },
    });
    expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
  });
});

test("run inherits stdin", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "stdin");
    const child = Bun.spawn([process.execPath, application, "sbx", "run", "--name", "example"], {
      ...options,
      env: { ...process.env, ...options.env },
      stdin: Buffer.from("hello\n"),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: "input:hello\n",
      stderr: "",
    });
  });
});

test.each(["interrupt", "ignore"])("run cancels the attached provider: %s", async (mode) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, mode);

    await withRunningCli(options, ["sbx", "run", "--name", "example"], async (cli) => {
      await cli.waitForReady(join(directory, "ready"));
      cli.interrupt();
      const result = await cli.result;

      expect(result.exitCode).toBe(130);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  });
});
