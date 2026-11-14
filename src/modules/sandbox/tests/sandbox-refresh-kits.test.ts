import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxHarness } from "./support/sandbox";

const running = JSON.stringify([{ name: "box", status: "running" }]);

async function refreshHarness(
  directory: string,
  options: { dryRun?: boolean; mixFailure?: boolean } = {},
) {
  const workspace = join(directory, "box", "repo");
  await Bun.write(join(workspace, ".keep"), "");

  return createSandboxHarness({
    directory,
    profile: "work",
    dryRun: options.dryRun,
    config: {
      sandbox: {
        default_provider: "docker-sbx",
        profiles: {
          work: {
            workspace: { mode: "clone", path: join(directory, "${{ sandbox.name }}", "repo") },
            kits: ["./local-kit", "registry.example/kit:1"],
            kit_args: { "tool.name": "${{ sandbox.name }}", enabled: true },
          },
        },
      },
    },
    run: async (args) => {
      if (args[0] === "kit" && options.mixFailure) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "error: cannot mix v3 kits with v1/v2 kits in one sandbox",
        };
      }

      return { exitCode: 0, stdout: args[0] === "ls" ? running : "", stderr: "" };
    },
  });
}

test("refreshKits adds each profile kit with freshly interpolated arguments", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, commands } = await refreshHarness(directory);

    const result = await service.refreshKits({ name: "box" });

    const adds = commands.filter(({ args }) => args[0] === "kit").map(({ args }) => args);
    expect(result.kits).toHaveLength(2);
    expect(adds).toEqual([
      [
        "kit",
        "add",
        "--kit-arg",
        "tool.name=box",
        "--kit-arg",
        "enabled=true",
        "--",
        "box",
        result.kits[0]!,
      ],
      [
        "kit",
        "add",
        "--kit-arg",
        "tool.name=box",
        "--kit-arg",
        "enabled=true",
        "--",
        "box",
        "registry.example/kit:1",
      ],
    ]);
  });
});

test("refreshKits prefers explicit kits and requires something to apply", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, commands } = await refreshHarness(directory);

    await service.refreshKits({ name: "box", kits: ["only/kit"] });

    expect(commands.filter(({ args }) => args[0] === "kit")).toHaveLength(1);

    const bare = await createSandboxHarness({
      directory,
      run: async () => ({ exitCode: 0, stdout: running, stderr: "" }),
    });
    await expect(bare.service.refreshKits({ name: "box" })).rejects.toMatchObject({
      code: "SANDBOX_INVALID_INPUT",
    });
  });
});

test("refreshKits dry-run records the additions without running them", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, execution, commands } = await refreshHarness(directory, { dryRun: true });

    await service.refreshKits({ name: "box" });

    expect(execution.operations.map(({ type }) => type)).toEqual([
      "sandbox.kit.add",
      "sandbox.kit.add",
    ]);
    expect(commands.map(({ args }) => args[0])).not.toContain("kit");
  });
});

test("refreshKits explains the sbx v3 and v1/v2 kit mix and stops at the first failure", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, commands } = await refreshHarness(directory, { mixFailure: true });

    const failure = await service.refreshKits({ name: "box" }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "SANDBOX_KIT_FAILED" });
    expect((failure as Error).message).toContain("cannot mix v3 kits with v1/v2 kits");
    expect(commands.filter(({ args }) => args[0] === "kit")).toHaveLength(1);
  });
});
