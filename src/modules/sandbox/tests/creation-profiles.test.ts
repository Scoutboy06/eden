import { expect, test } from "bun:test";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxHarness } from "./support/sandbox";

test("profile values fill omitted create inputs while explicit inputs win", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, execution, commands } = await createSandboxHarness({
      directory,
      profile: "work",
      config: {
        sandbox: {
          profiles: {
            work: { provider: "docker-sbx", template: "profile:image", agent: "claude" },
          },
        },
      },
    });

    await service.create({ name: "example", image: "explicit:image", agent: "codex" });

    expect(execution.operations[0]?.input).toMatchObject({
      name: "example",
      image: "explicit:image",
      agent: "codex",
      profile: "work",
    });
    expect(commands.at(-1)?.args).toContain("explicit:image");
    expect(commands.at(-1)?.args).toContain("codex");
  });
});

test.each(["__proto__", "work.profile", 'work "quoted" profile'])(
  "profile names are resolved literally: %s",
  async (name) => {
    await withTemporaryDirectory(async (directory) => {
      const { service, execution, commands } = await createSandboxHarness({
        directory,
        dryRun: true,
        profile: name,
        config: {
          sandbox: { profiles: { [name]: { provider: "docker-sbx", template: "profile:image" } } },
        },
      });

      await service.create({ name: "example" });

      expect(execution.operations[0]?.input.profile).toBe(name);
      expect(execution.operations[0]?.input.image).toBe("profile:image");
      expect(commands.map(({ args }) => args)).toEqual([
        ["ls", "--json"],
        ["policy", "ls", "--json"],
      ]);
    });
  },
);

test.each([false, true])(
  "profile template and agent remain in the creation plan, dryRun=%s",
  async (dryRun) => {
    await withTemporaryDirectory(async (directory) => {
      const { service, execution, commands } = await createSandboxHarness({
        directory,
        dryRun,
        profile: "work",
        config: {
          sandbox: {
            default_provider: "docker-sbx",
            profiles: { work: { template: "profile:image", agent: "claude" } },
          },
        },
      });

      await service.create({ name: "example" });

      expect(execution.operations[0]?.input).toEqual({
        provider: "docker-sbx",
        name: "example",
        image: "profile:image",
        agent: "claude",
        profile: "work",
      });
      expect(commands.map(({ args }) => args)).toEqual([
        ["ls", "--json"],
        ["policy", "ls", "--json"],
        ...(dryRun
          ? []
          : [
              [
                "create",
                "--name",
                "example",
                "--template",
                "profile:image",
                "--skills",
                "off",
                "--no-progress",
                "claude",
              ],
            ]),
      ]);
    });
  },
);

test.each([undefined, "claude"] as const)(
  "an empty profile uses provider defaults, global agent=%s",
  async (agent) => {
    await withTemporaryDirectory(async (directory) => {
      const { service, execution, commands } = await createSandboxHarness({
        directory,
        profile: "empty",
        config: {
          ...(agent ? { agent: { default: agent } } : {}),
          sandbox: { default_provider: "docker-sbx", profiles: { empty: {} } },
        },
      });

      await service.create({ name: "example" });

      expect(execution.operations[0]?.input).toEqual({
        provider: "docker-sbx",
        name: "example",
        profile: "empty",
      });
      expect(commands.at(-1)?.args).toEqual([
        "create",
        "--name",
        "example",
        "--skills",
        "off",
        "--no-progress",
        "shell",
      ]);
    });
  },
);

test("inherited object properties are not configured profiles", async () => {
  await withTemporaryDirectory(async (directory) => {
    await expect(createSandboxHarness({ directory, profile: "constructor" })).rejects.toMatchObject(
      {
        code: "SANDBOX_PROFILE_NOT_FOUND",
        message: 'Unknown sandbox profile "constructor". Configured profiles: none.',
      },
    );
  });
});

test("an empty profile cannot supply a missing provider", async () => {
  await withTemporaryDirectory(async (directory) => {
    await expect(
      createSandboxHarness({
        directory,
        profile: "empty",
        config: { sandbox: { profiles: { empty: {} } } },
      }),
    ).rejects.toMatchObject({
      code: "SANDBOX_INVALID_INPUT",
      message: expect.stringContaining("Choose a sandbox provider"),
    });
  });
});

test.each(["claude", "codex", "opencode"] as const)(
  "profile agent %s reaches the Docker adapter",
  async (agent) => {
    await withTemporaryDirectory(async (directory) => {
      const { service, commands } = await createSandboxHarness({
        directory,
        profile: "work",
        config: { sandbox: { default_provider: "docker-sbx", profiles: { work: { agent } } } },
      });

      await service.create({ name: "example" });

      expect(commands.map(({ args }) => args)).toEqual([
        ["ls", "--json"],
        ["policy", "ls", "--json"],
        ["create", "--name", "example", "--skills", "off", "--no-progress", agent],
      ]);
    });
  },
);

test.each([false, true])(
  "unsupported profile agent fails before provider calls, dryRun=%s",
  async (dryRun) => {
    await withTemporaryDirectory(async (directory) => {
      const { service, commands, execution } = await createSandboxHarness({
        directory,
        dryRun,
        profile: "work",
        config: {
          sandbox: { default_provider: "docker-sbx", profiles: { work: { agent: "omp" } } },
        },
      });

      await expect(service.create({ name: "example" })).rejects.toMatchObject({
        code: "SANDBOX_AGENT_UNSUPPORTED",
      });

      expect(commands).toEqual([]);
      expect(execution.operations).toEqual([]);
    });
  },
);
