import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { findRepositoryPath } from "../../config/repository";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.each(["clone", "host"])("%s uses the explicit path over the profile path", async (mode) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    const path = join(directory, "explicit path");
    await mkdir(path);
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { work: { workspace: { mode, path: "missing" } } },
        },
      }),
    );
    options.env.EDEN_SBX_WORKSPACE_MODE = mode;
    options.env.EDEN_SBX_WORKSPACE_PATH = path;

    const result = await runCliWith(
      options,
      "sbx",
      "create",
      "--name",
      "example",
      "--profile",
      "work",
      "--path",
      path,
    );

    expect(result.exitCode).toBe(0);
    expect((await sandboxCommands(directory)).at(-1)).toEqual([
      "create",
      "--name",
      "example",
      "--skills",
      "off",
      ...(mode === "clone" ? ["--clone"] : []),
      "shell",
      path,
    ]);
    expect(result.stderr.includes("Host workspace or mount is writable")).toBe(mode === "host");
  });
});

test.each(["clone", "host"])(
  "%s dry-run resolves the profile path and warns for host",
  async (mode) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await mkdir(join(directory, "work"));
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            default_provider: "docker-sbx",
            profiles: { work: { workspace: { mode, path: "work" } } },
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
      const operation = JSON.parse(result.stdout).operations[0];
      expect(operation.input.workspace).toEqual({ mode, path: join(directory, "work") });
      if (mode === "host")
        expect(operation.input.warnings[0]).toContain("Host workspace or mount is writable");
      expect(await sandboxCommands(directory)).toEqual([
        ["ls", "--json"],
        ["policy", "ls", "--json"],
      ]);
    });
  },
);

test("clone defaults to repository root from a nested directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    await mkdir(join(directory, ".git"));
    await mkdir(join(directory, "nested"));
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { work: { workspace: { mode: "clone" } } },
        },
      }),
    );

    const result = await runCliWith(
      { ...options, cwd: join(directory, "nested") },
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
    expect(JSON.parse(result.stdout).operations[0].input.workspace).toEqual({
      mode: "clone",
      path: directory,
    });
  });
});

test.each([
  { workspace: undefined, path: "existing" },
  { workspace: { mode: "none" }, path: "existing" },
  { workspace: { mode: "none", path: "existing" }, path: undefined },
  { workspace: { mode: "clone", path: "missing" }, path: undefined },
])(
  "invalid or unapproved workspace fails before provider calls: %j",
  async ({ workspace, path }) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await mkdir(join(directory, "existing"));
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: { default_provider: "docker-sbx", profiles: { work: { workspace } } },
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
        "--json",
        ...(path ? ["--path", path] : []),
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_INVALID_INPUT");
      expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
    });
  },
);

test.skipIf((await findRepositoryPath(tmpdir())) !== undefined)(
  "clone without a path fails when there is no repository ancestor",
  async () => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            default_provider: "docker-sbx",
            profiles: { work: { workspace: { mode: "clone" } } },
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
        "--json",
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_INVALID_INPUT");
      expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
    });
  },
);

test("none mode creates without workspace paths", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { work: { workspace: { mode: "none" } } },
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
      "--skills",
      "off",
      "shell",
    ]);
  });
});

test("human dry-run shows the resolved host path and warning", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { work: { workspace: { mode: "host", path: directory } } },
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
    expect(result.stdout).toContain(`host workspace ${directory}`);
    expect(result.stderr).toContain("Host workspace or mount is writable");
  });
});

test("workspace tilde expands to the home directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { work: { workspace: { mode: "clone", path: "~" } } },
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
    expect(JSON.parse(result.stdout).operations[0].input.workspace.path).toBe(process.env.HOME);
  });
});
