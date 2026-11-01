import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.each([false, true])(
  "resolves workspace, named mounts and kit arguments with dryRun=%s",
  async (dryRun) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      const workspace = join(directory, "example-repo");
      const packages = join(directory, "packages");
      const local = join(directory, "example-local");
      await Promise.all([mkdir(workspace), mkdir(packages), mkdir(local)]);
      options.env.EDEN_SBX_WORKSPACE_MODE = "clone";
      options.env.EDEN_SBX_WORKSPACE_PATH = workspace;
      options.env.EDEN_SBX_MOUNT_PATHS = JSON.stringify([`${packages}:ro`, local]);
      options.env.EDEN_SBX_RUN_KIT_FLAGS = JSON.stringify([
        "--kit-arg",
        "name=example",
        "--kit-arg",
        `cache=${packages}`,
        "--kit-arg",
        `dir=${workspace}`,
        "--kit-arg",
        "mode=clone",
      ]);
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            default_provider: "docker-sbx",
            profiles: {
              work: {
                workspace: { mode: "clone", path: "./${{ sandbox.name }}-repo" },
                mounts: {
                  packages: { path: "./packages", readonly: true },
                  local: { path: "./${{ sandbox.name }}-local" },
                },
                kit_args: {
                  name: "${{ sandbox.name }}",
                  cache: "${{ mounts.packages.sandboxPath }}",
                  dir: "${{ workspace.path }}",
                  mode: "${{ workspace.mode }}",
                },
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
        "--profile",
        "work",
        ...(dryRun ? ["--dry-run", "--json"] : []),
      );

      expect(result.exitCode).toBe(0);
      if (dryRun) {
        const input = JSON.parse(result.stdout).operations[0].input;
        expect(input.workspace).toEqual({ mode: "clone", path: workspace });
        expect(input.mounts).toEqual({
          packages: { path: packages, readonly: true },
          local: { path: local },
        });
        expect(input.kitArgs).toEqual({
          name: "example",
          cache: packages,
          dir: workspace,
          mode: "clone",
        });
        expect(input.warnings[0]).toContain("writable");
      } else {
        expect(result.stderr).toContain("writable");
        expect((await sandboxCommands(directory)).at(-1)).toEqual([
          "create",
          "--name",
          "example",
          "--kit-arg",
          "name=example",
          "--kit-arg",
          `cache=${packages}`,
          "--kit-arg",
          `dir=${workspace}`,
          "--kit-arg",
          "mode=clone",
          "--skills",
          "off",
          "--clone",
          "shell",
          workspace,
          `${packages}:ro`,
          local,
        ]);
      }
    });
  },
);

test.each([
  { workspace: { mode: "none" }, mounts: { data: { path: "." } } },
  { workspace: { mode: "clone", path: "." }, mounts: { missing: { path: "./missing" } } },
  {
    workspace: { mode: "clone", path: "." },
    mounts: { data: { path: "${{ mounts.data.hostPath }}" } },
  },
  { workspace: { mode: "clone", path: "." }, kit_args: { x: "${{ env.HOME }}" } },
  { workspace: { mode: "none" }, kit_args: { x: "${{ workspace.path }}" } },
  {
    workspace: { mode: "clone", path: "${{ mounts.data.hostPath }}" },
    mounts: { data: { path: "${{ workspace.path }}" } },
  },
  { workspace: { mode: "clone", path: "." }, mounts: { "data.bad": { path: "." } } },
  { workspace: { mode: "clone", path: "." }, kit_args: { x: "${{ mounts.missing.hostPath }}" } },
  { workspace: { mode: "clone", path: "." }, kit_args: { x: "${{ sandbox.name + 1 }}" } },
])("rejects invalid mount or expression before provider calls: %j", async (profile) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({ sandbox: { default_provider: "docker-sbx", profiles: { work: profile } } }),
    );

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

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_INVALID_INPUT");
    expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
  });
});

test("read-only mounts on a clone workspace do not trigger the writable warning", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: {
            work: {
              workspace: { mode: "clone", path: "." },
              mounts: { docs: { path: ".", readonly: true } },
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
      "--profile",
      "work",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).operations[0].input.warnings).toBeUndefined();
  });
});
