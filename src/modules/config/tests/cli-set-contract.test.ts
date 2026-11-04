import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { homedir } from "node:os";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { selectConfig } from "../select";
import { createConfigHarness } from "./support/config";
import { rootPrefix } from "./support/root";

test("config set validates, writes literal strings, and is observable through the reader", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "eden", "config.yaml");
    const { config } = createConfigHarness(path);

    await config.set("worktree_root", "~/trees/../worktrees");

    expect(selectConfig(await config.read(), "worktree_root")).toBe(join(homedir(), "worktrees"));
    expect(Bun.YAML.parse(await readFile(path, "utf8"))).toEqual({
      worktree_root: "~/trees/../worktrees",
    });
    await expect(config.set("agent.default", "unsupported")).rejects.toMatchObject({
      code: "CONFIG_SCHEMA_INVALID",
    });
  });
});

test.each([
  "~/trees/../worktrees",
  `${rootPrefix}/trees: with spaces/#literal`,
  `${rootPrefix}/true`,
  `${rootPrefix}/[literal]`,
])("config set preserves supplied string %j and unrelated YAML formatting", async (value) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const text = `# header\nagent:\n    default: 'codex'  # keep agent\n\nworktree_root: ${rootPrefix}/unchanged # keep root\n`;
    const { config } = createConfigHarness(path);
    await writeFile(path, text);

    await config.set("worktree_root", value);

    const edited = await readFile(path, "utf8");
    expect(Bun.YAML.parse(edited)).toEqual({ agent: { default: "codex" }, worktree_root: value });
    expect(edited).toContain("# header");
    expect(edited).toContain("# keep agent");
    expect(edited).toContain("# keep root");
    expect(selectConfig(await config.read(), "worktree_root")).toBe(
      value.startsWith("~/") ? join(homedir(), "worktrees") : normalize(value),
    );
  });
});

test.each([
  ["agent.typo", "claude", "CONFIG_KEY_UNKNOWN"],
  ["__proto__", "claude", "CONFIG_KEY_UNKNOWN"],
  ["agent", "{default: claude}", "CONFIG_KEY_NOT_LEAF"],
  ["agent.default", "null", "CONFIG_SCHEMA_INVALID"],
  ["agent.default", "unsupported", "CONFIG_SCHEMA_INVALID"],
  ["agent.default", "", "CONFIG_SCHEMA_INVALID"],
  ["worktree_root", "relative", "CONFIG_SCHEMA_INVALID"],
] as const)("config set rejects %s=%s without changing existing data", async (key, value, code) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const text = "# unchanged\nagent:\n  default: codex\n";
    const { config } = createConfigHarness(path);
    await writeFile(path, text);

    await expect(config.set(key, value)).rejects.toMatchObject({ code });

    expect(await readFile(path, "utf8")).toBe(text);
  });
});

test.each([
  ["agent: [", "CONFIG_YAML_INVALID"],
  ["agent:\n  default: unsupported\n", "CONFIG_SCHEMA_INVALID"],
  ["# empty\n", "CONFIG_EMPTY"],
] as const)("config set validates existing input before editing (%s)", async (text, code) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const { config } = createConfigHarness(path);
    await writeFile(path, text);

    await expect(config.set("agent.default", "claude")).rejects.toMatchObject({ code });

    expect(await readFile(path, "utf8")).toBe(text);
  });
});

test("config set dry-run records the planned mutation without writing", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const { config, execution } = createConfigHarness(path, true);

    await config.set("agent.default", "claude");

    expect(execution.operations).toMatchObject([
      { type: "config.set", input: { path, key: "agent.default", value: "claude" } },
    ]);
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

test.each([
  `# header\nagent:\n    default: 'codex'  # keep agent\n\nworktree_root : '${rootPrefix}/unchanged' # keep root\n`,
  `{ agent: { default: codex }, worktree_root: '${rootPrefix}/unchanged' } # keep\n`,
  `agent: {default: codex,} # keep\nworktree_root: ${rootPrefix}/unchanged\n`,
  `agent:\r\n    default: codex # keep\r\nworktree_root: ${rootPrefix}/unchanged\r\n`,
])("config edits preserve exact unrelated formatting in %j", async (text) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const { config } = createConfigHarness(path);
    await writeFile(path, text);

    await config.set("agent.default", "claude");

    expect(await readFile(path, "utf8")).toBe(text.replace("codex", "claude"));
  });
});

test.each([
  `# header\nworktree_root : '${rootPrefix}/unchanged' # keep root\n`,
  `agent: {} # keep\nworktree_root : '${rootPrefix}/unchanged' # keep root\n`,
  `{worktree_root: ${rootPrefix}/unchanged, } # keep\n`,
])("config edits add missing mappings without disturbing unrelated content in %j", async (text) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const { config } = createConfigHarness(path);
    await writeFile(path, text);

    await config.set("agent.default", "claude");
    const edited = await readFile(path, "utf8");

    expect(Bun.YAML.parse(edited)).toEqual({
      agent: { default: "claude" },
      worktree_root: `${rootPrefix}/unchanged`,
    });
    expect(edited).toContain(
      text.includes("# keep root")
        ? `worktree_root : '${rootPrefix}/unchanged' # keep root`
        : "# keep",
    );
  });
});

test("config dry-run leaves existing YAML untouched and still validates new values", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const text = "agent:\n  default: codex # keep\n";
    const { config, execution } = createConfigHarness(path, true);
    await writeFile(path, text);

    await config.set("agent.default", "claude");
    await expect(config.set("agent.default", "invalid")).rejects.toMatchObject({
      code: "CONFIG_SCHEMA_INVALID",
    });

    expect(await readFile(path, "utf8")).toBe(text);
    expect(execution.operations).toHaveLength(1);
  });
});
