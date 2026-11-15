import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import sbx from "../../../../apps/cli/src/commands/sbx";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { parseCommands } from "./support/parser";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test("sbx create uses a profile provider and template", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  options.env.EDEN_SBX_RUN_IMAGE = "registry.example.com/team:latest";
  await writeFile(
    join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
    stringify({
      sandbox: {
        profiles: { work: { provider: "docker-sbx", template: options.env.EDEN_SBX_RUN_IMAGE } },
      },
    }),
  );

  const result = await runCliWith(
    options,
    "sbx",
    "create",
    "--name",
    "example",
    "--profile",
    "work",
  );

  expect(result.exitCode).toBe(0);
  expect(await sandboxCommands(directory.path)).toEqual([
    ["ls", "--json"],
    ["policy", "ls", "--json"],
    [
      "create",
      "--name",
      "example",
      "--template",
      options.env.EDEN_SBX_RUN_IMAGE,
      "--skills",
      "off",
      "shell",
    ],
  ]);
});

test("sbx create dry-run resolves explicit flags over profile values without creation", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await writeFile(
    join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
    stringify({ sandbox: { profiles: { work: { template: "profile:image" } } } }),
  );

  const result = await runCliWith(
    options,
    "sbx",
    "create",
    "--name",
    "example",
    "--profile",
    "work",
    "--provider",
    "docker-sbx",
    "--image",
    "explicit:image",
    "--dry-run",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [
      {
        type: "sandbox.create",
        input: {
          provider: "docker-sbx",
          name: "example",
          image: "explicit:image",
          profile: "work",
        },
      },
    ],
  });
  expect(await sandboxCommands(directory.path)).toEqual([
    ["ls", "--json"],
    ["policy", "ls", "--json"],
  ]);
});

test("sbx create reports unknown profiles before contacting an explicitly selected provider", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await writeFile(
    join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
    stringify({ sandbox: { profiles: { work: {}, other: {} } } }),
  );

  const result = await runCliWith(
    options,
    "sbx",
    "create",
    "--name",
    "example",
    "--profile",
    "missing",
    "--provider",
    "docker-sbx",
    "--dry-run",
    "--json",
  );

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "SANDBOX_PROFILE_NOT_FOUND",
      message: 'Unknown sandbox profile "missing". Configured profiles: "other", "work".',
    },
  });
  expect(await Bun.file(join(directory.path, "commands")).exists()).toBe(false);
});

test("sbx run rejects a creation-only profile option before command execution", async () => {
  const result = await parseCommands(
    { sbx },
    "sbx",
    "run",
    "--name",
    "example",
    "--profile",
    "empty",
    "--dry-run",
    "--json",
  );

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "err:arg:unknown-option",
    message: "Unknown option: --profile",
  });
});

test("profile resolution reads repository overrides from a nested directory", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  const nested = join(directory.path, "src", "nested");
  await mkdir(join(directory.path, ".git"));
  await mkdir(join(directory.path, ".eden"));
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
    stringify({
      sandbox: { profiles: { work: { provider: "docker-sbx", template: "global:image" } } },
    }),
  );
  await writeFile(
    join(directory.path, ".eden", "config.yaml"),
    "sandbox:\n  profiles:\n    work:\n      template: repository:image\n",
  );
  await writeFile(
    join(directory.path, ".eden", "config.local.yaml"),
    "sandbox:\n  profiles:\n    work:\n      template: local:image\n",
  );

  const result = await runCliWith(
    { ...options, cwd: nested },
    "sbx",
    "create",
    "--name",
    "example",
    "--profile",
    "work",
    "--dry-run",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).operations[0].input).toEqual({
    provider: "docker-sbx",
    name: "example",
    image: "local:image",
    profile: "work",
  });
});

test("profile agent can be configured through the config command", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");

  const set = await runCliWith(options, "config", "set", "sandbox.profiles.work.agent", "claude");
  const get = await runCliWith(options, "config", "get", "sandbox.profiles.work.agent", "--json");

  expect(set.exitCode).toBe(0);
  expect(get.exitCode).toBe(0);
  expect(JSON.parse(get.stdout).value).toBe("claude");
});

test("sbx create dry-run passes a profile agent kit reference through", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");
  await writeFile(
    join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
    stringify({
      sandbox: {
        profiles: {
          work: { provider: "docker-sbx", agent: "docker.io/sbx/claude-kit:latest" },
        },
      },
    }),
  );

  const result = await runCliWith(
    options,
    "sbx",
    "create",
    "--name",
    "example",
    "--profile",
    "work",
    "--dry-run",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).operations[0].input.agent).toBe(
    "docker.io/sbx/claude-kit:latest",
  );
});
