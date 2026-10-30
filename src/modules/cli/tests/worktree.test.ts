import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createRepository, git } from "../../worktree/tests/support/repository";
import { runCliWith } from "./support/cli";

test("worktree create wires the requested name to creation and reports the result as JSON", async () => {
  await withTemporaryDirectory(async (directory) => {
    const repo = await createRepository(directory);
    const options = {
      cwd: repo,
      env: { HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: join(directory, "config") },
    };
    const path = join(directory, ".worktrees", "repo", "fix-login");
    const base = await git(repo, ["rev-parse", "HEAD"]);

    const result = await runCliWith(options, "worktree", "create", "--name", "Fix Login", "--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      dryRun: false,
      result: { branch: "fix-login", path, base },
      hooks: [],
    });
    expect(await git(path, ["branch", "--show-current"])).toBe("fix-login");
  });
});

test("worktree create wires the base option and configured root to creation", async () => {
  await withTemporaryDirectory(async (directory) => {
    const repo = await createRepository(directory);
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["branch", "starting-point"]);
    await git(repo, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "later"]);
    const root = join(directory, "trees");
    const xdg = join(directory, "config");
    await mkdir(join(xdg, "eden"), { recursive: true });
    await writeFile(join(xdg, "eden", "config.yaml"), `worktree_root: ${JSON.stringify(root)}\n`);
    const path = join(root, "repo", "configured");

    const result = await runCliWith(
      { cwd: repo, env: { XDG_CONFIG_HOME: xdg } },
      "worktree",
      "create",
      "--name",
      "configured",
      "--base-branch",
      "starting-point",
    );

    expect(result).toEqual({ exitCode: 0, stdout: `Created configured at ${path}\n`, stderr: "" });
    expect(await git(path, ["rev-parse", "HEAD"])).toBe(base);
  });
});
