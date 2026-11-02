import { expect, test } from "bun:test";
import { GitModule } from "../../git/git.module";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createGitContext, resolvePullRequestLookup, type GitContext } from "../resolve";

function context(
  remotes = [{ name: "origin", url: "https://github.com/acme/app" }],
  branch: string | undefined = "topic",
): GitContext {
  return { remotes: async () => remotes, branch: async () => branch };
}

test("explicit PR URL needs no local Git context", async () => {
  const git: GitContext = {
    remotes: async () => {
      throw new Error("must not inspect cwd");
    },
    branch: async () => {
      throw new Error("must not inspect branch");
    },
  };

  expect(
    await resolvePullRequestLookup({ ref: "https://github.com/acme/app/pull/1" }, git),
  ).toMatchObject({ kind: "exact", ref: { number: 1 } });
});

test("explicit repository overrides cwd but independently inherits the branch", async () => {
  expect(
    await resolvePullRequestLookup({ repo: "https://github.com/other/target" }, context()),
  ).toMatchObject({
    kind: "branch",
    repository: { owner: "other", repository: "target" },
    sourceBranch: "topic",
  });
});

test("explicit branch works without a local branch", async () => {
  expect(
    await resolvePullRequestLookup(
      { repo: "https://github.com/acme/app", head: "refs/heads/feature/login" },
      context([], undefined),
    ),
  ).toMatchObject({ kind: "branch", sourceBranch: "feature/login" });
});

test("PR number uses an inferred repository", async () => {
  expect(await resolvePullRequestLookup({ ref: "123" }, context())).toMatchObject({
    kind: "exact",
    ref: { provider: "github", number: 123 },
  });
});

test("equivalent remotes are unambiguous", async () => {
  const git = context([
    { name: "origin", url: "git@github.com:acme/app.git" },
    { name: "mirror", url: "https://github.com/acme/app" },
  ]);

  expect(await resolvePullRequestLookup({}, git)).toMatchObject({
    kind: "branch",
    sourceBranch: "topic",
  });
});

test("different repositories require explicit selection and list safe candidates", async () => {
  const git = context([
    { name: "origin", url: "https://github.com/me/fork" },
    { name: "upstream", url: "https://github.com/acme/app" },
  ]);

  await expect(resolvePullRequestLookup({}, git)).rejects.toMatchObject({
    code: "SCM_AMBIGUOUS_REPOSITORY",
  });
  expect(await resolvePullRequestLookup({ remote: "upstream", ref: "12" }, git)).toMatchObject({
    repository: { owner: "acme" },
    ref: { number: 12 },
  });
});

test("rejects contradictory explicit arguments", async () => {
  await expect(
    resolvePullRequestLookup({ repo: "https://github.com/acme/app", remote: "origin" }, context()),
  ).rejects.toMatchObject({ code: "SCM_CONFLICTING_INPUT" });
  await expect(
    resolvePullRequestLookup({ ref: "1", head: "topic" }, context()),
  ).rejects.toMatchObject({ code: "SCM_CONFLICTING_INPUT" });
  await expect(
    resolvePullRequestLookup(
      { ref: "https://github.com/other/app/pull/1", remote: "origin" },
      context(),
    ),
  ).rejects.toMatchObject({ code: "SCM_CONFLICTING_INPUT" });
});

test("missing repository, remote and branch have distinct errors", async () => {
  await expect(resolvePullRequestLookup({}, context([]))).rejects.toMatchObject({
    code: "SCM_REPOSITORY_REQUIRED",
  });
  await expect(resolvePullRequestLookup({ remote: "upstream" }, context())).rejects.toMatchObject({
    code: "SCM_REMOTE_NOT_FOUND",
  });
  await expect(
    resolvePullRequestLookup({}, { ...context(), branch: async () => undefined }),
  ).rejects.toMatchObject({ code: "SCM_BRANCH_REQUIRED" });
});

test("unsupported remotes are ignored unless explicitly selected", async () => {
  const git = context([
    { name: "backup", url: "https://gitlab.com/acme/app" },
    { name: "origin", url: "https://github.com/acme/app" },
  ]);

  expect(await resolvePullRequestLookup({}, git)).toMatchObject({
    repository: { provider: "github" },
  });
  await expect(resolvePullRequestLookup({ remote: "backup" }, git)).rejects.toMatchObject({
    code: "SCM_UNSUPPORTED_REMOTE",
  });
});

test("real Git context reads worktree branch and fetch remotes without fetching", async () => {
  await withTemporaryDirectory(async (cwd) => {
    await GitModule.execute(cwd, ["init", "-b", "topic"]);
    await GitModule.execute(cwd, ["remote", "add", "origin", "git@github.com:acme/app.git"]);

    expect(await resolvePullRequestLookup({}, createGitContext(cwd))).toMatchObject({
      kind: "branch",
      sourceBranch: "topic",
      repository: { repository: "app" },
    });
  });
});
