import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createExecution } from "../../execution";
import { createFileConfigService } from "../config.service";
import { ConfigError } from "../errors";

const defaults = { worktree_root: join(homedir(), ".worktrees") };

test("reads a configured agent from a YAML file", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  await writeFile(path, "agent:\n  default: claude\n");
  const service = createFileConfigService({ pathsLowToHigh: [path] });

  expect(await service.read()).toEqual({ ...defaults, agent: { default: "claude" } });
});

test("rejects invalid agent names without disclosing the rejected value", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
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

test("reports validation issues across root and nested settings", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  await writeFile(path, "agent:\n  default: invalid\n  defualt: claude\nunexpected: true\n");
  const service = createFileConfigService({ pathsLowToHigh: [path] });

  await expect(service.read()).rejects.toMatchObject({
    code: "CONFIG_SCHEMA_INVALID",
    path,
    issues: [{ path: "agent.default" }, { path: "agent.defualt" }, { path: "unexpected" }],
  });
});

test("defaults a missing file without creating it", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  const service = createFileConfigService({ pathsLowToHigh: [path] });

  expect(await service.read()).toEqual(defaults);
  expect(await Bun.file(path).exists()).toBe(false);
});

test("ignores legacy project registry configuration", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  await writeFile(path, "projects: null\n");

  expect(await createFileConfigService({ pathsLowToHigh: [path] }).read()).toEqual(defaults);
});

test("config updates preserve the legacy project source without exposing it as a setting", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  await writeFile(
    path,
    "agent:\n  default: codex\nprojects:\n  legacy:\n    name: Legacy\n    path: /legacy\n",
  );
  const service = createFileConfigService({
    pathsLowToHigh: [path],
    execution: createExecution({ dryRun: false }),
  });

  await service.set("agent.default", "claude");
  expect(await Bun.file(path).text()).toContain("projects:");
  expect((await service.read()).agent?.default).toBe("claude");
  await expect(service.set("projects.legacy.name", "Changed")).rejects.toThrow();
});

test.each(["", " \n\t", "# Configure Eden\n  # No settings yet\n"])(
  "rejects an empty or comments-only configuration: %j",
  async (text) => {
    await using directory = await createTemporaryDirectory();
    const path = join(directory.path, "config.yaml");
    await writeFile(path, text);
    const service = createFileConfigService({ pathsLowToHigh: [path] });

    await expect(service.read()).rejects.toMatchObject({ code: "CONFIG_EMPTY", path });
  },
);

test("reports malformed YAML separately from schema errors", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  await writeFile(path, "agent: [private-value\n");
  const service = createFileConfigService({ pathsLowToHigh: [path] });

  await expect(service.read()).rejects.toMatchObject({
    code: "CONFIG_YAML_INVALID",
    path,
  });
});

test.each([
  ["{}", {}],
  ["agent: {}", { agent: {} }],
  ["agent:\n  default: codex", { agent: { default: "codex" } }],
  ["agent:\n  default: opencode", { agent: { default: "opencode" } }],
] as const)("accepts optional settings without inventing defaults: %s", async (text, expected) => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  await writeFile(path, text);

  expect(await createFileConfigService({ pathsLowToHigh: [path] }).read()).toEqual({
    ...defaults,
    ...expected,
  });
});

test("does not read at construction and sees subsequent file edits", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  const service = createFileConfigService({ pathsLowToHigh: [path] });
  expect(await Bun.file(path).exists()).toBe(false);

  await writeFile(path, "agent:\n  default: codex\n");
  expect(await service.read()).toEqual({ ...defaults, agent: { default: "codex" } });
  await writeFile(path, "agent:\n  default: claude\n");
  expect(await service.read()).toEqual({ ...defaults, agent: { default: "claude" } });
  await writeFile(path, "agent:\n  default: invalid\n");
  await expect(service.read()).rejects.toMatchObject({ code: "CONFIG_SCHEMA_INVALID", path });
});

test("reports a filesystem read failure separately from a missing file", async () => {
  await using path = await createTemporaryDirectory();
  const service = createFileConfigService({ pathsLowToHigh: [path.path] });

  await expect(service.read()).rejects.toMatchObject({
    code: "CONFIG_READ_FAILED",
    path: path.path,
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
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  await writeFile(path, text);

  await expect(createFileConfigService({ pathsLowToHigh: [path] }).read()).rejects.toMatchObject({
    code: "CONFIG_SCHEMA_INVALID",
    path,
  });
});
