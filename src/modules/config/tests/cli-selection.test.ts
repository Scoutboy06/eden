import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createFileConfigService } from "../config.service";
import { selectConfig } from "../select";

test("selects the effective tree, subtree, and scalar leaves", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, "agent:\n  default: claude\nworktree_root: ~/trees/../worktrees\n");
    const config = await createFileConfigService({ pathsLowToHigh: [path] }).read();

    expect(selectConfig(config)).toEqual({
      agent: { default: "claude" },
      worktree_root: join(homedir(), "worktrees"),
    });
    expect(selectConfig(config, "agent")).toEqual({ default: "claude" });
    expect(selectConfig(config, "agent.default")).toBe("claude");
    expect(selectConfig(config, "worktree_root")).toBe(join(homedir(), "worktrees"));
  });
});

test.each([
  "unknown",
  "agent.defualt",
  "agent.default.child",
  "toString",
  "agent.__proto__",
  "agent.",
  "",
])("rejects unknown configuration selection %j", async (key) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, "agent: {}\n");
    const config = await createFileConfigService({ pathsLowToHigh: [path] }).read();

    expect(() => selectConfig(config, key)).toThrow(
      expect.objectContaining({
        code: "CONFIG_KEY_UNKNOWN",
        message: `Unknown configuration key: ${key}`,
      }),
    );
  });
});

test("returns undefined for an unset known setting", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const config = await createFileConfigService({ pathsLowToHigh: [path] }).read();

    expect(selectConfig(config, "agent.default")).toBeUndefined();
  });
});
