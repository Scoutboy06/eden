import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test("profile pull and disk settings reach sbx while retaining inherited environment", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    options.env.EDEN_SBX_PULL = "never";
    options.env.EDEN_SBX_ENV_LOG = join(directory, "environment.json");
    options.env.EDEN_INHERITED = "preserved";
    options.env.DOCKER_SANDBOXES_ROOT_SIZE = "inherited-size";
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { work: { pull: "never", disk: { root: "100g", docker: "50g" } } },
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
    expect((await sandboxCommands(directory)).at(-1)).toEqual([
      "create",
      "--name",
      "example",
      "--pull",
      "never",
      "--skills",
      "off",
      "shell",
    ]);
    expect(await Bun.file(options.env.EDEN_SBX_ENV_LOG).json()).toEqual({
      root: "100g",
      docker: "50g",
      inherited: "preserved",
    });
  });
});

test("unset disk settings preserve inherited values", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    options.env.EDEN_SBX_ENV_LOG = join(directory, "environment.json");
    options.env.DOCKER_SANDBOXES_ROOT_SIZE = "70g";
    options.env.DOCKER_SANDBOXES_DOCKER_SIZE = "30g";

    const result = await runCliWith(options, "sbx", "create", "--name", "example");

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(options.env.EDEN_SBX_ENV_LOG).json()).toEqual({
      root: "70g",
      docker: "30g",
    });
  });
});
