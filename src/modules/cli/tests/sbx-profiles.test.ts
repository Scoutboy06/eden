import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.each(["create", "run"])(
  "sbx %s creates using a profile provider and template",
  async (command) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      options.env.EDEN_SBX_RUN_IMAGE = "registry.example.com/team:latest";
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            profiles: {
              work: { provider: "docker-sbx", template: options.env.EDEN_SBX_RUN_IMAGE },
            },
          },
        }),
      );

      const result = await runCliWith(
        options,
        "sbx",
        command,
        "--name",
        "example",
        "--profile",
        "work",
      );

      expect(result.exitCode).toBe(0);
      expect(await sandboxCommands(directory)).toEqual([
        ...(command === "run" ? [["ls", "--format", "json"]] : []),
        ["ls", "--format", "json"],
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
        ...(command === "run" ? [["run", "--name", "example"]] : []),
      ]);
    });
  },
);

test.each(["create", "run"])(
  "sbx %s dry-run resolves explicit flags over profile values without creation",
  async (command) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            profiles: { work: { template: "profile:image" } },
          },
        }),
      );

      const result = await runCliWith(
        options,
        "sbx",
        command,
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
        operations: expect.arrayContaining([
          expect.objectContaining({
            type: "sandbox.create",
            input: {
              provider: "docker-sbx",
              name: "example",
              image: "explicit:image",
              profile: "work",
            },
          }),
        ]),
      });
      expect(await sandboxCommands(directory)).toEqual([
        ...(command === "run" ? [["ls", "--format", "json"]] : []),
        ["ls", "--format", "json"],
        ["policy", "ls", "--json"],
      ]);
    });
  },
);

test.each(["create", "run"])(
  "sbx %s dry-run includes the profile name and resolved template",
  async (command) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            default_provider: "docker-sbx",
            profiles: { work: { template: "profile:image" } },
          },
        }),
      );

      const result = await runCliWith(
        options,
        "sbx",
        command,
        "--name",
        "example",
        "--profile",
        "work",
        "--dry-run",
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).operations[0]).toMatchObject({
        type: "sandbox.create",
        input: { provider: "docker-sbx", name: "example", image: "profile:image", profile: "work" },
      });
    });
  },
);

test.each(["create", "run"])(
  "sbx %s uses provider defaults for an empty profile",
  async (command) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            default_provider: "docker-sbx",
            profiles: { empty: {} },
          },
        }),
      );

      const result = await runCliWith(
        options,
        "sbx",
        command,
        "--name",
        "example",
        "--profile",
        "empty",
        "--dry-run",
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).operations[0].input).toEqual({
        provider: "docker-sbx",
        name: "example",
        profile: "empty",
      });
    });
  },
);

test.each(["create", "run"])(
  "sbx %s rejects unknown profiles before contacting an explicitly selected provider",
  async (command) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            profiles: { work: {}, other: {} },
          },
        }),
      );

      const result = await runCliWith(
        options,
        "sbx",
        command,
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
      expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
    });
  },
);

test.each(["create", "run"])(
  "sbx %s reports no configured profiles without provider calls",
  async (command) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");

      const result = await runCliWith(
        options,
        "sbx",
        command,
        "--name",
        "example",
        "--profile",
        "constructor",
        "--dry-run",
        "--json",
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toEqual({
        code: "SANDBOX_PROFILE_NOT_FOUND",
        message: 'Unknown sandbox profile "constructor". Configured profiles: none.',
      });
      expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
    });
  },
);

test.each(["running", "stopped"])(
  "sbx run rejects a profile for an existing %s sandbox even without a template",
  async (mode) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, mode);
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            default_provider: "docker-sbx",
            profiles: { empty: {} },
          },
        }),
      );

      const result = await runCliWith(
        options,
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
        code: "SANDBOX_INVALID_INPUT",
        message: expect.stringContaining("omit --profile to attach"),
      });
      expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
    });
  },
);

test("profile resolution reads repository overrides from a nested directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    const nested = join(directory, "src", "nested");
    await mkdir(join(directory, ".git"));
    await mkdir(join(directory, ".eden"));
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          profiles: { work: { provider: "docker-sbx", template: "global:image" } },
        },
      }),
    );
    await writeFile(
      join(directory, ".eden", "config.yaml"),
      "sandbox:\n  profiles:\n    work:\n      template: repository:image\n",
    );
    await writeFile(
      join(directory, ".eden", "config.local.yaml"),
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
});

test.each(["__proto__", "work.profile", 'work "quoted" profile'])(
  "profile names are resolved literally: %s",
  async (name) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            profiles: { [name]: { provider: "docker-sbx", template: "profile:image" } },
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
        name,
        "--dry-run",
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).operations[0].input.profile).toBe(name);
    });
  },
);

test("an empty profile without any provider reports the existing provider selection error", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      "sandbox: { profiles: { empty: {} } }\n",
    );

    const result = await runCliWith(
      options,
      "sbx",
      "create",
      "--name",
      "example",
      "--profile",
      "empty",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "SANDBOX_INVALID_INPUT",
      message: expect.stringContaining("Choose a sandbox provider"),
    });
    expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
  });
});
