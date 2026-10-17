import { expect, test } from "bun:test";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createExecution } from "../../execution";
import { HookService } from "../../hook/hook.service";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { WorktreeService } from "../worktree.service";
import { createRepository, git } from "./support/repository";

async function createFixture(directory: string, dryRun = false) {
  const repo = await createRepository(directory);
  const root = join(directory, "trees");
  const execution = createExecution({ dryRun });
  const hooks = new HookService(execution, { directory: join(directory, "hooks") });
  const service = new WorktreeService(
    execution,
    { read: async () => ({ worktree_root: root }) },
    hooks,
  );

  return { repo, root, execution, service };
}

test("derives the branch and destination from a friendly name when invoked in a subdirectory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repo, root, service } = await createFixture(directory);
    const head = await git(repo, ["rev-parse", "HEAD"]);
    const nested = join(repo, "nested");
    await mkdir(nested);

    const result = await service.create({ name: " --Fix / LOGIN-- " }, nested);

    expect(result).toEqual({
      branch: "fix-login",
      path: join(root, "repo", "fix-login"),
      base: head,
    });
    expect(await git(result.path, ["branch", "--show-current"])).toBe("fix-login");
    expect(await git(result.path, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(repo, ["branch", "--show-current"])).toBe("main");
  });
});

test("uses the main repository's name and the caller's HEAD from a linked worktree", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repo, root, service } = await createFixture(directory);
    const first = await service.create({ name: "first" }, repo);
    await git(first.path, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "second",
    ]);
    const head = await git(first.path, ["rev-parse", "HEAD"]);

    const result = await service.create({ name: "second" }, first.path);

    expect(result.path).toBe(join(root, "repo", "second"));
    expect(result.base).toBe(head);
    expect(await git(result.path, ["rev-parse", "HEAD"])).toBe(head);
  });
});

test("an explicit base takes precedence over the caller's HEAD", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repo, service } = await createFixture(directory);
    const initial = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["branch", "starting-point"]);
    await git(repo, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "second"]);

    const result = await service.create({ name: "from-base", baseBranch: "starting-point" }, repo);

    expect(result.base).toBe(initial);
    expect(await git(result.path, ["rev-parse", "HEAD"])).toBe(initial);
  });
});

test("dry-run plans worktree creation without creating its parent directory or branch", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repo, root, execution, service } = await createFixture(directory, true);

    const result = await service.create({ name: "preview" }, repo);

    expect(execution.operations).toMatchObject([{ type: "git.worktree.create", input: result }]);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, ["for-each-ref", "refs/heads/preview"])).toBe("");
  });
});

test.each(["branch", "directory", "symlink"])(
  "dry-run leaves %s collision handling to Git during execution",
  async (collision) => {
    await withTemporaryDirectory(async (directory) => {
      const { repo, root, execution, service } = await createFixture(directory, true);
      const path = join(root, "repo", "taken");
      if (collision === "branch") await git(repo, ["branch", "taken"]);
      else {
        await mkdir(join(root, "repo"), { recursive: true });
        if (collision === "directory") await mkdir(path);
        else await symlink(join(directory, "missing"), path);
      }

      await service.create({ name: "taken" }, repo);
      expect(execution.operations).toHaveLength(1);
    });
  },
);

test.each(["!!!", "..", "bad..ref", "name.lock"])(
  "rejects a name that cannot produce a usable branch: %s",
  async (name) => {
    await withTemporaryDirectory(async (directory) => {
      const { repo, execution, service } = await createFixture(directory);

      await expect(service.create({ name }, repo)).rejects.toThrow();
      expect(execution.operations).toHaveLength(["!!!", ".."].includes(name) ? 0 : 1);
    });
  },
);

test("a missing base fails without creating directories or a branch", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { repo, root, execution, service } = await createFixture(directory);

    await expect(service.create({ name: "test", baseBranch: "missing" }, repo)).rejects.toThrow();
    expect(execution.operations).toHaveLength(0);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, ["for-each-ref", "refs/heads/test"])).toBe("");
  });
});

test("creation outside a repository fails before planning changes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { root, execution, service } = await createFixture(directory);

    await expect(service.create({ name: "test" }, directory)).rejects.toThrow();
    expect(execution.operations).toHaveLength(0);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
