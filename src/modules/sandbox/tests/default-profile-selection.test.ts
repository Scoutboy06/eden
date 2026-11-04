import { expect, mock, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxHarness } from "./support/sandbox";

test.each([
  { provider: undefined, image: undefined },
  { provider: "docker-sbx", image: undefined },
  { provider: undefined, image: "explicit:image" },
  { provider: "docker-sbx", image: "explicit:image" },
])(
  "default profile fields survive explicit provider/image overrides %j",
  async ({ provider, image }) => {
    await withTemporaryDirectory(async (directory) => {
      const kitArgs = { enabled: true, count: 3 };
      const { service, execution, commands } = await createSandboxHarness({
        directory,
        useDefaultProfile: true,
        dryRun: true,
        provider,
        config: {
          sandbox: {
            default_profile: "work",
            profiles: {
              work: {
                provider: "docker-sbx",
                template: "profile:image",
                kits: ["~/literal kit"],
                kit_args: kitArgs,
              },
            },
          },
        },
      });

      await service.create({ name: "example", ...(image === undefined ? {} : { image }) });

      expect(execution.operations).toEqual([
        {
          type: "sandbox.create",
          description: expect.any(String),
          input: {
            provider: "docker-sbx",
            name: "example",
            profile: "work",
            image: image ?? "profile:image",
            kits: [join(homedir(), "literal kit")],
            kitArgs,
          },
        },
      ]);
      expect(commands.map(({ args }) => args)).toEqual([
        ["ls", "--json"],
        ["policy", "ls", "--json"],
      ]);
    });
  },
);

test.each(["work", "missing"])(
  "an explicit profile replaces default %s without inheriting its fields",
  async (defaultProfile) => {
    await withTemporaryDirectory(async (directory) => {
      const { service, execution } = await createSandboxHarness({
        directory,
        profile: "other",
        useDefaultProfile: true,
        dryRun: true,
        config: {
          sandbox: {
            default_profile: defaultProfile,
            default_provider: "docker-sbx",
            profiles: {
              work: {
                template: "default:image",
                kits: ["default-kit"],
                kit_args: { enabled: true },
              },
              other: {},
            },
          },
        },
      });

      await service.create({ name: "example" });

      expect(execution.operations[0]?.input).toEqual({
        provider: "docker-sbx",
        name: "example",
        profile: "other",
      });
    });
  },
);

test.each([{ provider: undefined }, { provider: "docker-sbx" }])(
  "unknown default profile fails before provider calls %j",
  async ({ provider }) => {
    await withTemporaryDirectory(async (directory) => {
      const run = mock(async () => ({ exitCode: 0, stdout: "[]", stderr: "" }));
      await expect(
        createSandboxHarness({
          directory,
          useDefaultProfile: true,
          dryRun: true,
          provider,
          run,
          config: {
            sandbox: { default_profile: "missing", profiles: { work: {} } },
          },
        }),
      ).rejects.toMatchObject({
        code: "SANDBOX_PROFILE_NOT_FOUND",
        message: 'Unknown sandbox profile "missing". Configured profiles: "work".',
      });

      expect(run).not.toHaveBeenCalled();
    });
  },
);

test.each(["__proto__", 'work.profile "quoted"'])(
  "treats default profile name literally: %s",
  async (name) => {
    await withTemporaryDirectory(async (directory) => {
      const { service, execution } = await createSandboxHarness({
        directory,
        useDefaultProfile: true,
        dryRun: true,
        config: {
          sandbox: {
            default_profile: name,
            profiles: { [name]: { provider: "docker-sbx" } },
          },
        },
      });

      await service.create({ name: "example" });

      expect(execution.operations[0]?.input.profile).toBe(name);
    });
  },
);
