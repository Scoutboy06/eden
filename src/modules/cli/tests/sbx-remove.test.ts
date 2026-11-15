import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith, withRunningCli } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

async function installRemoveHook(configHome: string) {
  const directory = join(configHome, "eden", "hooks");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "sandbox.remove.pre");
  await copyFile(new URL("./fixtures/sandbox-hook.ts", import.meta.url), path);
  await chmod(path, 0o755);
}

test("force removes exactly one sandbox and skips the remove hook", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "running");
  await installRemoveHook(options.env.XDG_CONFIG_HOME!);

  const result = await runCliWith(options, "sbx", "rm", "--name", "example", "--force", "--json");

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).sandbox).toEqual({ provider: "docker-sbx", name: "example" });
  expect(await sandboxCommands(directory.path)).toEqual([
    ["ls", "--json"],
    ["rm", "--force", "--", "example"],
  ]);
});

test("noninteractive removal requires force before provider calls", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");

  const result = await runCliWith(options, "sbx", "rm", "--name", "example", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "SANDBOX_REMOVE_REQUIRES_FORCE",
    message: expect.stringContaining("terminal"),
  });
  expect(await Bun.file(join(directory.path, "commands")).exists()).toBe(false);
});

test("dry-run records the remove hook and removal without executing either", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");
  await installRemoveHook(options.env.XDG_CONFIG_HOME!);

  const result = await runCliWith(options, "sbx", "rm", "--name", "example", "--dry-run", "--json");

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).operations.map((op: any) => op.type)).toEqual([
    "hook.run",
    "sandbox.remove",
  ]);
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("running sandbox removal requires force even in dry-run", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "running");

  const result = await runCliWith(options, "sbx", "rm", "--name", "example", "--dry-run", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_REMOVE_REQUIRES_FORCE");
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("removal provider errors stay structured", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");
  options.env.EDEN_SBX_REMOVE_FAILURE = "provider failure";

  const result = await runCliWith(options, "sbx", "rm", "--name", "example", "--force", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "SANDBOX_REMOVE_FAILED",
    message: expect.stringContaining("provider failure"),
  });
});

test.skipIf(process.platform === "win32" || !Bun.which("script"))(
  "interactive removal runs the pre-hook and preserves provider terminal confirmation",
  async () => {
    await using directory = await createTemporaryDirectory();
    const options = await prepareSandboxCli(directory.path, "stopped");
    await installRemoveHook(options.env.XDG_CONFIG_HOME!);
    options.env.EDEN_SBX_REQUIRE_TTY = "1";
    const application = new URL("../../../../apps/cli/src/main.ts", import.meta.url).pathname;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const child = Bun.spawn(
      [
        "script",
        "-q",
        "-e",
        "-c",
        `${quote(process.execPath)} ${quote(application)} sbx rm --name example`,
        "/dev/null",
      ],
      {
        cwd: directory.path,
        env: { ...process.env, ...options.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write("y\n");
    child.stdin.end();
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Confirm removal?");
    expect(stdout).toContain("diagnostic from sandbox.remove.pre");
    const events = await sandboxCommands(directory.path);
    expect(events.map((event: any) => event.hook ?? event[0])).toEqual([
      "ls",
      "sandbox.remove.pre",
      "rm",
    ]);
    expect(events[1].input).toMatchObject({
      sandbox: { name: "example", provider: "docker-sbx", status: "stopped" },
    });
    expect(events[2]).toEqual(["rm", "--", "example"]);
  },
);

test.skipIf(process.platform === "win32" || !Bun.which("script"))(
  "a failing removal hook reports stderr and prevents removal",
  async () => {
    await using directory = await createTemporaryDirectory();
    const options = await prepareSandboxCli(directory.path, "stopped");
    await installRemoveHook(options.env.XDG_CONFIG_HOME!);
    options.env.EDEN_HOOK_EXIT = "7";
    const application = new URL("../../../../apps/cli/src/main.ts", import.meta.url).pathname;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const child = Bun.spawn(
      [
        "script",
        "-q",
        "-e",
        "-c",
        `${quote(process.execPath)} ${quote(application)} sbx rm --name example`,
        "/dev/null",
      ],
      {
        cwd: directory.path,
        env: { ...process.env, ...options.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("diagnostic from sandbox.remove.pre");
    expect(
      (await sandboxCommands(directory.path)).map((event: any) => event.hook ?? event[0]),
    ).toEqual(["ls", "sandbox.remove.pre"]);
  },
);

test("cancelled removal reports that the sandbox may already be removed", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");
  options.env.EDEN_SBX_REMOVE_WAIT = "1";

  const result = await withRunningCli(
    options,
    ["sbx", "rm", "--name", "example", "--force", "--json"],
    async (cli) => {
      await cli.waitForReady(options.env.EDEN_SBX_RUN_READY!);
      cli.interrupt();
      return cli.result;
    },
  );

  expect(result.exitCode).toBe(130);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "CANCELLED",
    message: expect.stringContaining("may already have been removed"),
  });
  expect(await sandboxCommands(directory.path)).toEqual([
    ["ls", "--json"],
    ["rm", "--force", "--", "example"],
  ]);
});

test("missing sandbox is not removed and reports provider selection", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");

  const result = await runCliWith(options, "sbx", "rm", "--name", "absent", "--force", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "SANDBOX_NOT_FOUND",
    message: expect.stringContaining("--provider"),
  });
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("unknown sandbox status requires force", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "pending");

  const result = await runCliWith(options, "sbx", "rm", "--name", "example", "--dry-run", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_REMOVE_REQUIRES_FORCE");
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("inferred removal rejects force before provider calls", async () => {
  await using directory = await createTemporaryDirectory();
  const checkout = join(directory.path, "My Project");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const options = await prepareSandboxCli(directory.path, "stopped", "my-project");

  const result = await runCliWith({ ...options, cwd: checkout }, "sbx", "rm", "--force", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "SANDBOX_INVALID_INPUT",
    message: expect.stringContaining("inferred"),
  });
  expect(await Bun.file(join(directory.path, "commands")).exists()).toBe(false);
});

test("inferred removal still requires a terminal to confirm", async () => {
  await using directory = await createTemporaryDirectory();
  const checkout = join(directory.path, "My Project");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const options = await prepareSandboxCli(directory.path, "stopped", "my-project");

  const result = await runCliWith({ ...options, cwd: checkout }, "sbx", "rm", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_REMOVE_REQUIRES_FORCE");
  expect(await Bun.file(join(directory.path, "commands")).exists()).toBe(false);
});

test("inferred dry-run removal names the inferred sandbox and removes nothing", async () => {
  await using directory = await createTemporaryDirectory();
  const checkout = join(directory.path, "My Project");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const options = await prepareSandboxCli(directory.path, "stopped", "my-project");

  const result = await runCliWith({ ...options, cwd: checkout }, "sbx", "rm", "--dry-run");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Using sandbox my-project because");
  expect(result.stdout).toContain("Remove sandbox my-project");
  expect(await sandboxCommands(directory.path)).toEqual([
    ["ls", "--json"],
    ["ls", "--json"],
  ]);
});
