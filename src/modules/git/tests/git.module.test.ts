import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitModule } from "../git.module";

describe("GitModule read API", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "eden-git-read-"));
    await GitModule.execute(directory, ["init", "-b", "main"]);
    await GitModule.execute(directory, ["config", "user.name", "Eden Test"]);
    await GitModule.execute(directory, ["config", "user.email", "eden@example.test"]);
    await GitModule.execute(directory, ["config", "commit.gpgsign", "false"]);
    await GitModule.execute(directory, [
      "config",
      "core.hooksPath",
      join(directory, "disabled-hooks"),
    ]);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("reports unborn, detached, staged, unstaged, untracked, and NUL-delimited rename paths", async () => {
    const initial = await GitModule.status(directory);
    expect(initial.head).toEqual({ kind: "unborn", branch: "main" });

    await writeFile(join(directory, "old name.txt"), "first\n");
    await GitModule.execute(directory, ["add", "."]);
    await GitModule.execute(directory, ["commit", "-m", "initial"]);
    await GitModule.execute(directory, ["mv", "old name.txt", "new name.txt"]);
    await writeFile(join(directory, "new name.txt"), "changed\n");
    await writeFile(join(directory, "untracked\nname.txt"), "new\n");

    const status = await GitModule.status(directory);
    expect(status.head.kind).toBe("branch");
    expect(status.staged).toContainEqual(
      expect.objectContaining({
        path: "new name.txt",
        originalPath: "old name.txt",
        indexStatus: "R",
      }),
    );
    expect(status.unstaged).toContainEqual(
      expect.objectContaining({ path: "new name.txt", worktreeStatus: "M" }),
    );
    expect(status.untracked).toEqual(["untracked\nname.txt"]);

    await GitModule.execute(directory, ["checkout", "--detach"]);
    expect((await GitModule.status(directory)).head.kind).toBe("detached");
  });

  test("lists local branch commit, upstream counts, and associated worktree paths", async () => {
    await writeFile(join(directory, "file"), "content\n");
    await GitModule.execute(directory, ["add", "."]);
    await GitModule.execute(directory, ["commit", "-m", "initial"]);
    await GitModule.execute(directory, ["branch", "topic"]);
    const remote = join(directory, "remote.git");
    const peer = join(directory, "peer");
    await GitModule.execute(directory, ["init", "--bare", remote]);
    await GitModule.execute(directory, ["remote", "add", "origin", remote]);
    await GitModule.execute(directory, ["push", "-u", "origin", "main"]);
    await GitModule.execute(directory, [
      "--git-dir",
      remote,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    await GitModule.execute(directory, ["clone", remote, peer]);
    await GitModule.execute(peer, ["config", "user.name", "Eden Test"]);
    await GitModule.execute(peer, ["config", "user.email", "eden@example.test"]);
    await writeFile(join(peer, "peer-file"), "peer\n");
    await GitModule.execute(peer, ["add", "."]);
    await GitModule.execute(peer, ["commit", "-m", "peer"]);
    await GitModule.execute(peer, ["push"]);
    await GitModule.execute(directory, ["fetch", "origin"]);
    const peerCommit = await GitModule.resolveCommit(peer);
    await GitModule.execute(directory, ["update-ref", "refs/remotes/origin/main", peerCommit]);
    await writeFile(join(directory, "local-file"), "local\n");
    await GitModule.execute(directory, ["add", "."]);
    await GitModule.execute(directory, ["commit", "-m", "local"]);

    const branches = await GitModule.localBranches(directory);
    await GitModule.execute(directory, ["config", "status.aheadBehind", "false"]);
    expect((await GitModule.status(directory)).upstream).toEqual({
      name: "origin/main",
      ahead: 1,
      behind: 1,
    });
    expect(branches).toContainEqual({
      name: "main",
      commit: expect.any(String),
      upstream: "origin/main",
      ahead: 1,
      behind: 1,
      worktrees: [directory],
    });
    expect(branches.find((branch) => branch.name === "topic")?.worktrees).toEqual([]);
  });

  test("lists current worktrees with branch names and detached state", async () => {
    await writeFile(join(directory, "file"), "content\n");
    await GitModule.execute(directory, ["add", "."]);
    await GitModule.execute(directory, ["commit", "-m", "initial"]);
    const topic = join(directory, "topic worktree");
    await GitModule.execute(directory, ["worktree", "add", "-b", "topic", topic]);
    const detached = join(directory, "detached-worktree");
    await GitModule.execute(directory, ["worktree", "add", "--detach", detached]);

    expect(
      (await GitModule.worktrees(directory)).sort((a, b) => a.path.localeCompare(b.path)),
    ).toEqual([
      { path: directory, branch: "main" },
      { path: detached, branch: null },
      { path: topic, branch: "topic" },
    ]);
  });

  test("reports unmerged paths explicitly", async () => {
    await writeFile(join(directory, "conflict"), "base\n");
    await GitModule.execute(directory, ["add", "."]);
    await GitModule.execute(directory, ["commit", "-m", "base"]);
    await GitModule.execute(directory, ["checkout", "-b", "side"]);
    await writeFile(join(directory, "conflict"), "side\n");
    await GitModule.execute(directory, ["commit", "-am", "side"]);
    await GitModule.execute(directory, ["checkout", "main"]);
    await writeFile(join(directory, "conflict"), "main\n");
    await GitModule.execute(directory, ["commit", "-am", "main"]);
    await expect(GitModule.execute(directory, ["merge", "side"])).rejects.toThrow();

    expect((await GitModule.status(directory)).conflicts).toContainEqual(
      expect.objectContaining({ path: "conflict" }),
    );
  });

  test("honors status overrides while reporting all untracked files", async () => {
    await writeFile(join(directory, "tracked"), "base\n");
    await GitModule.execute(directory, ["add", "."]);
    await GitModule.execute(directory, ["commit", "-m", "initial"]);
    await GitModule.execute(directory, ["config", "status.showUntrackedFiles", "no"]);
    await GitModule.execute(directory, ["config", "status.aheadBehind", "false"]);
    await mkdir(join(directory, "untracked"));
    await writeFile(join(directory, "untracked", "child"), "new\n");

    expect((await GitModule.status(directory)).untracked).toEqual(["untracked/child"]);
  });

  test("keeps missing upstream divergence unknown", async () => {
    await writeFile(join(directory, "file"), "content\n");
    await GitModule.execute(directory, ["add", "."]);
    await GitModule.execute(directory, ["commit", "-m", "initial"]);
    await GitModule.execute(directory, ["branch", "topic"]);
    await GitModule.execute(directory, ["config", "branch.topic.remote", "origin"]);
    await GitModule.execute(directory, ["config", "branch.topic.merge", "refs/heads/deleted"]);

    const topic = (await GitModule.localBranches(directory)).find(
      (branch) => branch.name === "topic",
    );
    expect(topic?.upstream).toBeNull();
    expect(topic?.ahead).toBeNull();
    expect(topic?.behind).toBeNull();
  });

  test("uses full refs for colliding branch names and maps linked worktrees", async () => {
    await writeFile(join(directory, "file"), "content\n");
    await GitModule.execute(directory, ["add", "."]);
    await GitModule.execute(directory, ["commit", "-m", "initial"]);
    await GitModule.execute(directory, ["branch", "topic"]);
    await GitModule.execute(directory, ["tag", "topic"]);
    const linked = join(directory, "linked-topic");
    await GitModule.execute(directory, ["worktree", "add", "--", linked, "topic"]);

    const topic = (await GitModule.localBranches(directory)).find(
      (branch) => branch.name === "topic",
    );
    expect(topic).toEqual({
      name: "topic",
      commit: expect.any(String),
      upstream: null,
      ahead: null,
      behind: null,
      worktrees: [linked],
    });
  });

  test("returns an empty local branch list for an unborn repository and rejects non-repositories", async () => {
    expect(await GitModule.localBranches(directory)).toEqual([]);
    const notRepository = await mkdtemp(join(tmpdir(), "eden-not-repository-"));
    try {
      await expect(GitModule.localBranches(notRepository)).rejects.toThrow();
      await expect(GitModule.status(notRepository)).rejects.toThrow();
    } finally {
      await rm(notRepository, { recursive: true, force: true });
    }
  });
});
