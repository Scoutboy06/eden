import { expect, test } from "bun:test";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith, withRunningCli } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.skipIf(process.platform === "win32" || !Bun.which("script"))(
  "interactive create exposes sbx credential approval through the terminal",
  async () => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      options.env.EDEN_SBX_CREDENTIAL_MODE = "missing";
      const application = new URL("../../../../apps/cli/src/main.ts", import.meta.url).pathname;
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const child = Bun.spawn(
        [
          "script",
          "-q",
          "-e",
          "-c",
          `${quote(process.execPath)} ${quote(application)} sbx create --name example`,
          "/dev/null",
        ],
        {
          cwd: directory,
          env: { ...process.env, ...options.env },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      child.stdin.write("y\n");
      child.stdin.end();
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Approve kit credential?");
      expect(stdout).toContain("Created sandbox example");
      expect((await sandboxCommands(directory)).at(-1)).toEqual([
        "create",
        "--name",
        "example",
        "--skills",
        "off",
        "shell",
      ]);
    });
  },
);

test.each([false, true])(
  "noninteractive missing approval is an actionable failure, json=%s",
  async (json) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      options.env.EDEN_SBX_CREDENTIAL_MODE = "missing";

      const result = await runCliWith(
        options,
        "sbx",
        "create",
        "--name",
        "example",
        ...(json ? ["--json"] : []),
      );

      expect(result.exitCode).toBe(1);
      const message = json ? JSON.parse(result.stdout).error.message : result.stderr;
      if (json)
        expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_CREDENTIAL_APPROVAL_REQUIRED");
      expect(message).toContain("was created and is left in place");
      expect(message).toContain("sbx create --name <new-name>");
      expect((await sandboxCommands(directory)).at(-1)?.[0]).toBe("create");
    });
  },
);

test("already-approved noninteractive creation succeeds in JSON mode", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    options.env.EDEN_SBX_CREDENTIAL_MODE = "approved";

    const result = await runCliWith(options, "sbx", "create", "--name", "example", "--json");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, sandbox: { name: "example" } });
    expect(result.stderr).toBe("");
  });
});

test("cancelling create while awaiting approval does not retry", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    options.env.EDEN_SBX_CREDENTIAL_MODE = "wait";

    const result = await withRunningCli(
      options,
      ["sbx", "create", "--name", "example", "--json"],
      async (cli) => {
        await cli.waitForReady(options.env.EDEN_SBX_RUN_READY!);
        cli.interrupt();
        return cli.result;
      },
    );

    expect(result.exitCode).toBe(130);
    expect(JSON.parse(result.stdout).error.code).toBe("CANCELLED");
    expect((await sandboxCommands(directory)).map((args: string[]) => args[0])).toEqual([
      "ls",
      "policy",
      "create",
    ]);
  });
});
