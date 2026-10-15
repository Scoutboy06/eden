import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createFileConfigService } from "../config.service";
import { ConfigError } from "../errors";

const defaults = { worktree_root: join(homedir(), ".worktrees") };

test("reads a configured agent from a YAML file", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, "agent:\n  default: claude\n");
    const service = createFileConfigService({ pathsLowToHigh: [path] });

    expect(await service.read()).toEqual({ ...defaults, agent: { default: "claude" } });
  });
});

test("rejects invalid agent names without disclosing the rejected value", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, "agent:\n  default: private-value\n");
    const service = createFileConfigService({ pathsLowToHigh: [path] });

    const error = await service.read().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({
      code: "CONFIG_SCHEMA_INVALID",
      path,
      issues: [{ path: "agent.default" }],
    });
    expect(JSON.stringify(error)).not.toContain("private-value");
    expect((error as ConfigError).message).not.toContain("private-value");
  });
});

test("reports validation issues across root and nested settings", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, "agent:\n  default: invalid\n  defualt: claude\nunexpected: true\n");
    const service = createFileConfigService({ pathsLowToHigh: [path] });

    await expect(service.read()).rejects.toMatchObject({
      code: "CONFIG_SCHEMA_INVALID",
      path,
      issues: [{ path: "agent.default" }, { path: "agent.defualt" }, { path: "unexpected" }],
    });
  });
});

test("defaults a missing file without creating it", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const service = createFileConfigService({ pathsLowToHigh: [path] });

    expect(await service.read()).toEqual(defaults);
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

test.each(["", " \n\t", "# Configure Eden\n  # No settings yet\n"])(
  "rejects an empty or comments-only configuration: %j",
  async (text) => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "config.yaml");
      await writeFile(path, text);
      const service = createFileConfigService({ pathsLowToHigh: [path] });

      await expect(service.read()).rejects.toMatchObject({ code: "CONFIG_EMPTY", path });
    });
  },
);

test("reports malformed YAML separately from schema errors", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, "agent: [private-value\n");
    const service = createFileConfigService({ pathsLowToHigh: [path] });

    await expect(service.read()).rejects.toMatchObject({
      code: "CONFIG_YAML_INVALID",
      path,
    });
  });
});

test.each([
  ["{}", {}],
  ["agent: {}", { agent: {} }],
  ["agent:\n  default: codex", { agent: { default: "codex" } }],
  ["agent:\n  default: opencode", { agent: { default: "opencode" } }],
] as const)("accepts optional settings without inventing defaults: %s", async (text, expected) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, text);

    expect(await createFileConfigService({ pathsLowToHigh: [path] }).read()).toEqual({
      ...defaults,
      ...expected,
    });
  });
});

test("does not read at construction and sees subsequent file edits", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const service = createFileConfigService({ pathsLowToHigh: [path] });
    expect(await Bun.file(path).exists()).toBe(false);

    await writeFile(path, "agent:\n  default: codex\n");
    expect(await service.read()).toEqual({ ...defaults, agent: { default: "codex" } });
    await writeFile(path, "agent:\n  default: claude\n");
    expect(await service.read()).toEqual({ ...defaults, agent: { default: "claude" } });
    await writeFile(path, "agent:\n  default: invalid\n");
    await expect(service.read()).rejects.toMatchObject({ code: "CONFIG_SCHEMA_INVALID", path });
  });
});

test("reports a filesystem read failure separately from a missing file", async () => {
  await withTemporaryDirectory(async (path) => {
    const service = createFileConfigService({ pathsLowToHigh: [path] });

    await expect(service.read()).rejects.toMatchObject({ code: "CONFIG_READ_FAILED", path });
  });
});

test.each(["xdg", "home"] as const)("reads the global configuration using %s", async (location) => {
  await withTemporaryDirectory(async (directory) => {
    const home = join(directory, "home");
    const xdg = join(directory, "xdg");
    const configHome = location === "xdg" ? xdg : join(home, ".config");
    await mkdir(join(configHome, "eden"), { recursive: true });
    await writeFile(join(configHome, "eden", "config.yaml"), "agent:\n  default: opencode\n");
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("./fixtures/read.ts", import.meta.url))],
      {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: location === "xdg" ? xdg : "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      worktree_root: join(home, ".worktrees"),
      agent: { default: "opencode" },
    });
  });
});

test.each([
  "null",
  "[]",
  "claude",
  "agent: null",
  "agent: []",
  "agent:\n  default: 123",
  "agent:\n  default: ''",
  "agent:\n  default: ' claude '",
  "agent:\n  default: null",
])("rejects invalid configuration shapes and values: %s", async (text) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, text);

    await expect(createFileConfigService({ pathsLowToHigh: [path] }).read()).rejects.toMatchObject({
      code: "CONFIG_SCHEMA_INVALID",
      path,
    });
  });
});
