import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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

test("dry-run shows resource settings and expanded kit paths without creating", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: {
            work: {
              pull: "never",
              disk: { root: "100g" },
              kits: [
                "~/first",
                "~\\second",
                "./third",
                "../fourth",
                "oci://registry/kit",
                "https://example.com/kit.git",
                "vendor/kit",
              ],
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
    expect(JSON.parse(result.stdout).operations[0].input).toMatchObject({
      pull: "never",
      disk: { root: "100g" },
      kits: [
        join(homedir(), "first"),
        join(homedir(), "second"),
        join(directory, "third"),
        join(directory, "..", "fourth"),
        "oci://registry/kit",
        "https://example.com/kit.git",
        "vendor/kit",
      ],
    });
    expect(await sandboxCommands(directory)).toEqual([
      ["ls", "--json"],
      ["policy", "ls", "--json"],
    ]);
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

test("both home path separators reach sbx as host paths", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    options.env.EDEN_SBX_RUN_KIT_FLAGS = JSON.stringify([
      "--kit",
      join(homedir(), "first"),
      "--kit",
      join(homedir(), "second"),
    ]);
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { work: { kits: ["~/first", "~\\second"] } },
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
      "--kit",
      join(homedir(), "first"),
      "--kit",
      join(homedir(), "second"),
      "--skills",
      "off",
      "shell",
    ]);
  });
});

test("human dry-run shows resolved kits and resource settings", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { work: { pull: "never", disk: { root: "100g" }, kits: ["~/example"] } },
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
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(join(homedir(), "example"));
    expect(result.stdout).toContain("Pull: never");
    expect(result.stdout).toContain("root=100g");
  });
});
