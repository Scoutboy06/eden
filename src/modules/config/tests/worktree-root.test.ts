import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createFileConfigService } from "../config.service";

test.each(["~", "~/trees", "/var/worktrees"])("resolves worktree_root %s", async (root) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, `worktree_root: ${JSON.stringify(root)}\n`);

    const config = await createFileConfigService({ pathsLowToHigh: [path] }).read();

    expect(config.worktree_root).toBe(
      root === "~" ? homedir() : root === "~/trees" ? join(homedir(), "trees") : root,
    );
    expect(config.agent).toBeUndefined();
  });
});

test.each(["", "relative/path", "~someone/trees", "/trees\0", null, 123])(
  "rejects invalid worktree_root %j",
  async (root) => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "config.yaml");
      await writeFile(path, `worktree_root: ${JSON.stringify(root)}\n`);

      await expect(
        createFileConfigService({ pathsLowToHigh: [path] }).read(),
      ).rejects.toMatchObject({
        code: "CONFIG_SCHEMA_INVALID",
        issues: [{ path: "worktree_root" }],
      });
    });
  },
);
