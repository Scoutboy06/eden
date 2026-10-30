import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import * as v from "valibot";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createFileConfigService } from "../config.service";
import { createWorktreeRootSchema } from "../schema";
import { rootPrefix } from "./support/root";

const absolute = `${rootPrefix}/var/worktrees`;

test.each(["~", "~/trees", absolute])("resolves worktree_root %s", async (root) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, `worktree_root: ${JSON.stringify(root)}\n`);

    const config = await createFileConfigService({ pathsLowToHigh: [path] }).read();

    expect(config.worktree_root).toBe(
      root === "~" ? homedir() : root === "~/trees" ? join(homedir(), "trees") : normalize(root),
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
const windows = createWorktreeRootSchema("win32", () => String.raw`C:\Users\me`);
const posix = createWorktreeRootSchema("linux", () => "/home/me");

test.each(["/wt", String.raw`\wt`, "C:wt", String.raw`relative\wt`, String.raw`~someone\wt`])(
  "rejects %j as a worktree_root on Windows, naming the setting",
  (root) => {
    const result = v.safeParse(windows, root);

    expect(result.success).toBe(false);
    expect(result.issues?.[0]?.message).toContain("worktree_root");
  },
);

test.each([
  [String.raw`C:\wt`, String.raw`C:\wt`],
  ["D:/wt/../trees", String.raw`D:\trees`],
  [String.raw`\\server\share\wt`, String.raw`\\server\share\wt`],
  ["//server/share/wt", String.raw`\\server\share\wt`],
  ["~", String.raw`C:\Users\me`],
])("accepts %j as a worktree_root on Windows", (root, expected) => {
  expect(v.parse(windows, root)).toBe(expected);
});

test("expands a backslash tilde prefix like a slash one on Windows", () => {
  expect(v.parse(windows, String.raw`~\x\y`)).toBe(String.raw`C:\Users\me\x\y`);
  expect(v.parse(windows, "~/x/y")).toBe(v.parse(windows, String.raw`~\x\y`));
});

test("keeps POSIX worktree_root behaviour unchanged", () => {
  expect(v.parse(posix, "/wt")).toBe("/wt");
  expect(v.parse(posix, "~/x")).toBe("/home/me/x");
  expect(v.safeParse(posix, String.raw`~\x`).success).toBe(false);
  expect(v.safeParse(posix, String.raw`C:\wt`).success).toBe(false);
  expect(v.safeParse(posix, "relative").issues?.[0]?.message).toContain("absolute");
});
