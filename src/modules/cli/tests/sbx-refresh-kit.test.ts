import { expect, test } from "bun:test";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

async function prepareRefreshCli(directory: string) {
  const options = await prepareSandboxCli(directory, "running");
  await Bun.write(
    join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
    stringify({
      sandbox: {
        default_provider: "docker-sbx",
        profiles: {
          tools: { kits: ["registry.example/tools:1"], kit_args: { who: "${{ sandbox.name }}" } },
        },
      },
    }),
  );

  return options;
}

test("refresh-kit adds the profile kits to the existing sandbox", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareRefreshCli(directory);

    const result = await runCliWith(
      options,
      "sbx",
      "refresh-kit",
      "--name",
      "example",
      "--profile",
      "tools",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      sandbox: { name: "example" },
      kits: ["registry.example/tools:1"],
    });
    expect((await sandboxCommands(directory)).at(-1)).toEqual([
      "kit",
      "add",
      "--kit-arg",
      "who=example",
      "--",
      "example",
      "registry.example/tools:1",
    ]);
  });
});

test("refresh-kit takes explicit kits and previews them with --dry-run", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareRefreshCli(directory);

    const result = await runCliWith(
      options,
      "sbx",
      "refresh-kit",
      "--name",
      "example",
      "--kit",
      "one/kit",
      "--kit",
      "two/kit",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).operations).toHaveLength(2);
    expect((await sandboxCommands(directory)).map((args) => args[0])).not.toContain("kit");
  });
});

test("refresh-kit reports the sbx kit version mix clearly", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareRefreshCli(directory);
    options.env.EDEN_SBX_KIT_FAILURE = "error: cannot mix v3 kits with v1/v2 kits in one sandbox";

    const result = await runCliWith(
      options,
      "sbx",
      "refresh-kit",
      "--name",
      "example",
      "--profile",
      "tools",
      "--json",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "SANDBOX_KIT_FAILED",
      message: expect.stringContaining("cannot mix v3 kits with v1/v2 kits"),
    });
  });
});
