import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith, withRunningCli } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

async function installHook(configHome: string, name: string) {
  const directory = join(configHome, "eden", "hooks");
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await copyFile(new URL("./fixtures/sandbox-hook.ts", import.meta.url), path);
  await chmod(path, 0o755);
}

test("create hooks receive resolved sandbox input in lifecycle order", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.pre");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.post");
  await writeFile(
    join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
    stringify({
      sandbox: {
        default_provider: "docker-sbx",
        profiles: { work: { agent: "claude", pull: "never", disk: { root: "80g" } } },
      },
    }),
  );
  options.env.EDEN_SBX_AGENT = "claude";
  options.env.EDEN_SBX_PULL = "never";

  const result = await runCliWith(
    options,
    "sbx",
    "create",
    "--name",
    "example",
    "--profile",
    "work",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  const events = await sandboxCommands(directory.path);
  expect(events.map((event: any) => event.hook ?? event[0])).toEqual([
    "ls",
    "policy",
    "sandbox.create.pre",
    "create",
    "sandbox.create.post",
  ]);
  expect(events[2].input).toMatchObject({
    request: { name: "example", profile: "work" },
    context: { cwd: directory.path },
    sandbox: {
      provider: "docker-sbx",
      name: "example",
      profile: "work",
      agent: "claude",
      pull: "never",
      disk: { root: "80g" },
    },
  });
  expect(JSON.parse(result.stdout).hooks).toHaveLength(2);
});

test("verbose displays captured sandbox post-hook stdout on stderr", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.post");
  options.env.EDEN_HOOK_OUTPUT = "sandbox post details\n";

  const result = await runCliWith(options, "sbx", "create", "--name", "example", "--verbose");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("diagnostic from sandbox.create.post\n");
  expect(result.stderr).toEndWith("sandbox post details\n");
});

test.each(["invalid", "fail"])("pre hook %s stops sandbox creation", async (mode) => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.pre");
  if (mode === "invalid") options.env.EDEN_HOOK_OUTPUT = '{"overwrites":{}}';
  else options.env.EDEN_HOOK_EXIT = "4";

  const result = await runCliWith(options, "sbx", "create", "--name", "example", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("HOOK_FAILED");
  expect(JSON.parse(result.stdout).hooks[0].stderr).toContain("diagnostic");
  expect(
    (await sandboxCommands(directory.path)).map((event: any) => event.hook ?? event[0]),
  ).toEqual(["ls", "policy", "sandbox.create.pre"]);
});

test("post failure reports that the created sandbox remains", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.post");
  options.env.EDEN_HOOK_EXIT = "5";

  const result = await runCliWith(options, "sbx", "create", "--name", "example", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.message).toContain("was created and is left in place");
  expect(
    (await sandboxCommands(directory.path)).map((event: any) => event.hook ?? event[0]),
  ).toEqual(["ls", "policy", "create", "sandbox.create.post"]);
});

test("failed create does not invoke the post hook", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.post");
  options.env.EDEN_SBX_CREATE_FAILURE = "create failed";

  const result = await runCliWith(options, "sbx", "create", "--name", "example", "--json");

  expect(result.exitCode).toBe(1);
  expect(
    (await sandboxCommands(directory.path)).map((event: any) => event.hook ?? event[0]),
  ).toEqual(["ls", "policy", "create"]);
});

test("dry-run records hooks without executing them or creating", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.pre");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.post");

  const result = await runCliWith(
    options,
    "sbx",
    "create",
    "--name",
    "example",
    "--dry-run",
    "--verbose",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).operations.map((op: any) => op.type)).toEqual([
    "hook.run",
    "sandbox.create",
    "hook.run",
  ]);
  expect(await sandboxCommands(directory.path)).toEqual([
    ["ls", "--json"],
    ["policy", "ls", "--json"],
  ]);
});

test("cancelling a post hook leaves the created sandbox and reports cancellation", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.post");
  options.env.EDEN_HOOK_READY = join(directory.path, "hook-ready");

  const result = await withRunningCli(
    options,
    ["sbx", "create", "--name", "example", "--json"],
    async (cli) => {
      await cli.waitForReady(options.env.EDEN_HOOK_READY!);
      cli.interrupt();
      return cli.result;
    },
  );

  expect(result.exitCode).toBe(130);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "CANCELLED",
    message: expect.stringContaining("was created and is left in place"),
  });
});

test("attachment never runs creation hooks", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "running");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.pre");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.post");

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
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
  expect(JSON.parse(result.stdout).operations.map((op: any) => op.type)).toEqual(["sandbox.run"]);
});

test("a failed prerequisite does not run creation hooks", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.pre");
  options.env.EDEN_SBX_LIST_FAILURE = "preflight unavailable";

  const result = await runCliWith(options, "sbx", "create", "--name", "example", "--json");

  expect(result.exitCode).toBe(1);
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("cancelling the pre hook prevents creation", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.pre");
  options.env.EDEN_HOOK_READY = join(directory.path, "pre-ready");

  const result = await withRunningCli(
    options,
    ["sbx", "create", "--name", "example", "--json"],
    async (cli) => {
      await cli.waitForReady(options.env.EDEN_HOOK_READY!);
      cli.interrupt();
      return cli.result;
    },
  );

  expect(result.exitCode).toBe(130);
  expect(JSON.parse(result.stdout).error.code).toBe("CANCELLED");
  expect(
    (await sandboxCommands(directory.path)).map((event: any) => event.hook ?? event[0]),
  ).toEqual(["ls", "policy", "sandbox.create.pre"]);
});

test("start runs the start hook after starting, with the remembered profile", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");
  await writeFile(
    join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
    stringify({
      sandbox: {
        default_provider: "docker-sbx",
        profiles: { work: { agent: "claude", pull: "never" } },
      },
    }),
  );
  options.env.EDEN_SBX_AGENT = "claude";
  options.env.EDEN_SBX_PULL = "never";
  await runCliWith(options, "sbx", "create", "--name", "example", "--profile", "work");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.start.post");

  const result = await runCliWith(options, "sbx", "start", "--name", "example", "--json");

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).hooks).toHaveLength(1);
  const events = await sandboxCommands(directory.path);
  expect(events.at(-1)).toMatchObject({
    hook: "sandbox.start.post",
    input: {
      request: { name: "example", profile: "work" },
      context: { cwd: directory.path },
      sandbox: { name: "example", provider: "docker-sbx", status: "running", profile: "work" },
    },
  });
  expect(events.at(-3)).toEqual(["run", "--detach", "--name", "example"]);
});

test("start does not run the start hook for a sandbox that is already running", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "running");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.start.post");

  const result = await runCliWith(options, "sbx", "start", "--name", "example", "--json");

  expect(result.exitCode).toBe(0);
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("start hook failure reports that the sandbox remains running", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.start.post");
  options.env.EDEN_HOOK_EXIT = "5";

  const result = await runCliWith(options, "sbx", "start", "--name", "example", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "HOOK_FAILED",
    message: expect.stringContaining("was started and is left running"),
  });
});

test("run starts a stopped sandbox through the start hook before attaching", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");
  await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.start.post");

  const result = await runCliWith(options, "sbx", "run", "--name", "example");

  expect(result.exitCode).toBe(0);
  expect(
    (await sandboxCommands(directory.path)).map((event: any) => event.hook ?? event[0]),
  ).toEqual(["ls", "run", "ls", "sandbox.start.post", "run"]);
});
