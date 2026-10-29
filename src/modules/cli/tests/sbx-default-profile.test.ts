import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.each([
  { flags: [] },
  { flags: ["--provider", "docker-sbx"] },
  { flags: ["--image", "explicit:image"] },
  { flags: ["--provider", "docker-sbx", "--image", "explicit:image"] },
])("create retains default profile fields with explicit flags %j", async ({ flags }) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    const kits = ["~/literal kit"];
    const kitArgs = { enabled: true, count: 3 };
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_profile: "work",
          profiles: {
            work: {
              provider: "docker-sbx",
              template: "profile:image",
              kits,
              kit_args: kitArgs,
            },
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
      ...flags,
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).operations[0].input).toEqual({
      provider: "docker-sbx",
      name: "example",
      profile: "work",
      image: flags.some((flag) => flag === "--image") ? "explicit:image" : "profile:image",
      kits,
      kitArgs,
    });
    expect(await sandboxCommands(directory)).toEqual([
      ["ls", "--format", "json"],
      ["policy", "ls", "--json"],
    ]);
  });
});

test("create executes using the default profile", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    options.env.EDEN_SBX_RUN_IMAGE = "profile:image";
    options.env.EDEN_SBX_RUN_KIT_FLAGS = JSON.stringify([
      "--kit",
      "literal kit",
      "--kit-arg",
      "enabled=true",
    ]);
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_profile: "work",
          profiles: {
            work: {
              provider: "docker-sbx",
              template: "profile:image",
              kits: ["literal kit"],
              kit_args: { enabled: true },
            },
          },
        },
      }),
    );

    const result = await runCliWith(options, "sbx", "create", "--name", "example");

    expect(result.exitCode).toBe(0);
    expect(await sandboxCommands(directory)).toEqual([
      ["ls", "--format", "json"],
      ["policy", "ls", "--json"],
      [
        "create",
        "--name",
        "example",
        "--template",
        "profile:image",
        "--kit",
        "literal kit",
        "--kit-arg",
        "enabled=true",
        "--skills",
        "off",
        "shell",
      ],
    ]);
  });
});

test.each(["work", "missing"])(
  "an explicit profile replaces the default %s without inheriting its fields",
  async (defaultProfile) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            default_provider: "docker-sbx",
            default_profile: defaultProfile,
            profiles: {
              work: {
                template: "default:image",
                kits: ["default-kit"],
                kit_args: { enabled: true },
              },
              other: {},
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
        "other",
        "--dry-run",
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).operations[0].input).toEqual({
        provider: "docker-sbx",
        name: "example",
        profile: "other",
      });
    });
  },
);

test.each([{ flags: [] }, { flags: ["--provider", "docker-sbx", "--image", "explicit:image"] }])(
  "unknown default profile fails before provider calls with flags %j",
  async ({ flags }) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        "sandbox: { default_profile: missing, profiles: { work: {} } }\n",
      );

      const result = await runCliWith(
        options,
        "sbx",
        "create",
        "--name",
        "example",
        ...flags,
        "--dry-run",
        "--json",
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toEqual({
        code: "SANDBOX_PROFILE_NOT_FOUND",
        message: 'Unknown sandbox profile "missing". Configured profiles: "work".',
      });
      expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
    });
  },
);

test.each(["run", "list", "stop"])("%s ignores an unknown default profile", async (command) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "stopped");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      "sandbox: { default_provider: docker-sbx, default_profile: missing }\n",
    );

    const result = await runCliWith(
      options,
      "sbx",
      command,
      ...(command === "list" ? [] : ["--name", "example"]),
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
    expect(
      JSON.parse(result.stdout).operations?.some(
        (operation: { type: string }) => operation.type === "sandbox.create",
      ) ?? false,
    ).toBe(false);
  });
});

test.each(["__proto__", 'work.profile "quoted"'])(
  "default profile names are literal: %s",
  async (name) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            default_profile: name,
            profiles: { [name]: { provider: "docker-sbx" } },
          },
        }),
      );

      const result = await runCliWith(
        options,
        "sbx",
        "create",
        "--name",
        "example",
        "--dry-run",
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).operations[0].input.profile).toBe(name);
    });
  },
);

test("create resolves repository-local default profile from a nested directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    const nested = join(directory, "src");
    await mkdir(join(directory, ".git"));
    await mkdir(join(directory, ".eden"));
    await mkdir(nested);
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_profile: "global",
          profiles: { local: { provider: "docker-sbx", template: "local:image" } },
        },
      }),
    );
    await writeFile(
      join(directory, ".eden", "config.yaml"),
      "sandbox: { default_profile: repository }\n",
    );
    await writeFile(
      join(directory, ".eden", "config.local.yaml"),
      "sandbox: { default_profile: local }\n",
    );

    const result = await runCliWith(
      { ...options, cwd: nested },
      "sbx",
      "create",
      "--name",
      "example",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).operations[0].input).toEqual({
      provider: "docker-sbx",
      name: "example",
      profile: "local",
      image: "local:image",
    });
  });
});
