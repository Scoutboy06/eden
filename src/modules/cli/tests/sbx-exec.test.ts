import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith, withRunningCli } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.each([false, true])(
  "exec preserves argv and returns nonzero status, json=%s",
  async (json) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "failure");
      const result = await runCliWith(
        options,
        "sbx",
        "exec",
        "--name",
        "example",
        ...(json ? ["--json"] : []),
        "--",
        "echo",
        "a b",
        "--",
        "--json",
      );
      expect(result.exitCode).toBe(7);
      if (json)
        expect(JSON.parse(result.stdout)).toEqual({
          ok: true,
          dryRun: false,
          result: { exitCode: 7, stdout: "command stdout\n", stderr: "command stderr\n" },
        });
      else
        expect(result).toEqual({
          exitCode: 7,
          stdout: "command stdout\n",
          stderr: "command stderr\n",
        });
      expect(await sandboxCommands(directory)).toEqual([
        ["ls", "--json"],
        ["exec", ...(json ? [] : ["-i"]), "--", "example", "echo", "a b", "--", "--json"],
      ]);
    });
  },
);

test.each([false, true])("exec missing sandbox never runs, dryRun=%s", async (dryRun) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    const result = await runCliWith(
      options,
      "sbx",
      "exec",
      "--name",
      "example",
      "--json",
      ...(dryRun ? ["--dry-run"] : []),
      "--",
      "echo",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "SANDBOX_NOT_FOUND", message: expect.stringContaining("--provider") },
    });
    expect(await sandboxCommands(directory)).toEqual([["ls", "--json"]]);
  });
});

test("exec dry-run reports the operation without a result", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");
    const result = await runCliWith(
      options,
      "sbx",
      "exec",
      "--name",
      "example",
      "--json",
      "--dry-run",
      "--",
      "echo",
      "a b",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      dryRun: true,
      operations: [{ type: "sandbox.exec", input: { argv: ["echo", "a b"], output: "capture" } }],
    });
    expect(await sandboxCommands(directory)).toEqual([["ls", "--json"]]);
  });
});

test("exec maps provider failure to structured error", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "provider-failure");
    const result = await runCliWith(
      options,
      "sbx",
      "exec",
      "--name",
      "example",
      "--json",
      "--",
      "echo",
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "SANDBOX_PROVIDER_UNAVAILABLE" },
    });
  });
});

test("exec cancellation stops the child", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "interrupt");
    await withRunningCli(
      options,
      ["sbx", "exec", "--name", "example", "--json", "--", "echo"],
      async (cli) => {
        await cli.waitForReady(join(directory, "ready"));
        cli.interrupt();
        const result = await cli.result;
        expect(result.exitCode).toBe(130);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { code: "CANCELLED" },
        });
      },
    );
  });
});

test.skipIf(process.platform === "win32" || !Bun.which("script"))(
  "exec restores the terminal after the provider changes its mode",
  async () => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "terminal");
      const application = new URL("../../../../apps/cli/src/main.ts", import.meta.url).pathname;
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const command = `before=$(stty -g); ${quote(process.execPath)} ${quote(application)} sbx exec --name example -- echo; after=$(stty -g); test "$before" = "$after"`;
      const child = Bun.spawn(["script", "-q", "-e", "-c", command, "/dev/null"], {
        cwd: directory,
        env: { ...process.env, ...options.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("command stdout");
    });
  },
);
