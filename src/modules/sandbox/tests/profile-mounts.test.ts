import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxProfile } from "../../config/schema";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { sandboxPath } from "../sandbox-paths";
import { createSandboxHarness } from "./support/sandbox";

const invalidProfiles: ((directory: string) => SandboxProfile)[] = [
  (directory: string) => ({
    workspace: { mode: "none" },
    mounts: { data: { path: directory } },
  }),
  (directory: string) => ({
    workspace: { mode: "clone", path: directory },
    mounts: { missing: { path: join(directory, "missing") } },
  }),
  (directory: string) => ({
    workspace: { mode: "clone", path: directory },
    mounts: { data: { path: "${{ mounts.data.hostPath }}" } },
  }),
  (directory: string) => ({
    workspace: { mode: "clone", path: directory },
    kit_args: { x: "${{ env.HOME }}" },
  }),
  () => ({
    workspace: { mode: "none" },
    kit_args: { x: "${{ workspace.path }}" },
  }),
  () => ({
    workspace: { mode: "clone", path: "${{ mounts.data.hostPath }}" },
    mounts: { data: { path: "${{ workspace.path }}" } },
  }),
  (directory: string) => ({
    workspace: { mode: "clone", path: directory },
    mounts: { "data.bad": { path: directory } },
  }),
  (directory: string) => ({
    workspace: { mode: "clone", path: directory },
    kit_args: { x: "${{ mounts.missing.hostPath }}" },
  }),
  (directory: string) => ({
    workspace: { mode: "clone", path: directory },
    kit_args: { x: "${{ sandbox.name + 1 }}" },
  }),
];

test.each(invalidProfiles.map((profile, index) => [index + 1, profile] as const))(
  "rejects invalid mount or expression before provider calls: case %d",
  async (_index, makeProfile) => {
    await withTemporaryDirectory(async (directory) => {
      const { service, commands } = await createSandboxHarness({
        directory,
        profile: "work",
        config: {
          sandbox: {
            default_provider: "docker-sbx",
            profiles: { work: makeProfile(directory) },
          },
        },
      });

      await expect(service.create({ name: "example" })).rejects.toMatchObject({
        code: "SANDBOX_INVALID_INPUT",
      });
      expect(commands).toEqual([]);
    });
  },
);

test("read-only mounts on a clone workspace do not trigger the writable warning", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, execution, warnings } = await createSandboxHarness({
      directory,
      profile: "work",
      dryRun: true,
      config: {
        sandbox: {
          default_provider: "docker-sbx",
          profiles: {
            work: {
              workspace: { mode: "clone", path: directory },
              mounts: { docs: { path: directory, readonly: true } },
            },
          },
        },
      },
    });

    await service.create({ name: "example" });

    expect(execution.operations[0]?.input).not.toHaveProperty("warnings");
    expect(warnings).toEqual([]);
  });
});

test.each([false, true])(
  "mounts marked create get their directory only when not previewing, dryRun=%s",
  async (dryRun) => {
    await withTemporaryDirectory(async (directory) => {
      const mountPath = join(directory, "per-sandbox", "${{ sandbox.name }}");
      const { service, execution, commands } = await createSandboxHarness({
        directory,
        profile: "work",
        dryRun,
        config: {
          sandbox: {
            default_provider: "docker-sbx",
            profiles: {
              work: {
                workspace: { mode: "clone", path: directory },
                mounts: { files: { path: mountPath, create: true } },
              },
            },
          },
        },
      });

      await service.create({ name: "example" });

      const created = join(directory, "per-sandbox", "example");
      expect(
        await stat(created).then(
          () => true,
          () => false,
        ),
      ).toBe(!dryRun);
      expect(execution.operations.map(({ type }) => type)).toContain("sandbox.mount.create");
      expect(commands.some(({ args }) => args.includes(created))).toBe(!dryRun);
    });
  },
);

test("kit arguments can use the sandbox path of the workspace", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, commands } = await createSandboxHarness({
      directory,
      profile: "work",
      config: {
        sandbox: {
          default_provider: "docker-sbx",
          profiles: {
            work: {
              workspace: { mode: "clone", path: directory },
              kit_args: { "kit.repoPath": "${{ workspace.sandboxPath }}" },
            },
          },
        },
      },
    });

    await service.create({ name: "example" });

    const create = commands.find(({ args }) => args[0] === "create");
    expect(create?.args).toContain(`kit.repoPath=${sandboxPath(directory)}`);
  });
});
