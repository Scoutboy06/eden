import { expect, mock, test } from "bun:test";

import { ScmError } from "../../../src/modules/pull-requests/errors";
import type {
  PullRequestBranchFinder,
  PullRequestProvider,
  PullRequestRef,
  RepositoryRef,
} from "../../../src/modules/pull-requests/provider";
import { projectWorktrees } from "./worktrees";

const githubRepository = {
  provider: "github" as const,
  owner: "acme",
  repository: "app",
};

const pr = {
  ref: { ...githubRepository, number: 12 },
  title: "Improve login",
  url: "https://github.com/acme/app/pull/12",
  state: "merged" as const,
  isDraft: false,
  sourceBranch: "topic",
  targetBranch: "main",
  body: "",
};

function dependencies(
  overrides: {
    repositories?: string[];
    remoteUrl?: (name: string) => string;
    find?: (branch: string) => Promise<PullRequestRef[]>;
    providerCreate?: () => Promise<PullRequestProvider>;
    getPullRequest?: () => Promise<typeof pr>;
    getReviews?: () => Promise<{ reviewer: { id: string; name: string }; state: "approved" }[]>;
    getChecks?: () => Promise<{ id: string; name: string; state: "passed" }[]>;
  } = {},
) {
  const provider = {
    findPullRequestsBySourceBranch: ({ sourceBranch }: { sourceBranch: string }) =>
      overrides.find?.(sourceBranch) ?? Promise.resolve([pr.ref]),
    getPullRequest: overrides.getPullRequest ?? (async () => pr),
    getComments: async () => [],
    findOpenPullRequests: async () => [],
    getReviews:
      overrides.getReviews ??
      (async () => [{ reviewer: { id: "user:1", name: "alice" }, state: "approved" as const }]),
    getChecks:
      overrides.getChecks ??
      (async () => [{ id: "check:1", name: "build", state: "passed" as const }]),
  } as PullRequestProvider & PullRequestBranchFinder;

  return {
    worktrees: async () => [
      { path: "/private/project", branch: "main" },
      { path: "/private/project/topic", branch: "topic" },
    ],
    remotes: async (_cwd: string, args: readonly string[]) =>
      args.length === 1
        ? (overrides.repositories ?? ["origin"]).join("\n")
        : (overrides.remoteUrl?.(args[3] ?? "") ?? "git@github.com:acme/app.git"),
    createProvider: overrides.providerCreate ?? (async (_repository: RepositoryRef) => provider),
  };
}

test("projects real branch matches with merged lifecycle, draft, reviewer and CI details", async () => {
  const result = await projectWorktrees("/private/project", dependencies());

  expect(result.worktrees).toEqual([
    {
      name: "project",
      branch: "main",
      state: "available",
      pr: { ref: pr.ref, title: pr.title, url: pr.url, state: pr.state, isDraft: pr.isDraft },
      reviews: [{ name: "alice", state: "approved" }],
      checks: [{ name: "build", state: "passed" }],
    },
    {
      name: "topic",
      branch: "topic",
      state: "available",
      pr: { ref: pr.ref, title: pr.title, url: pr.url, state: pr.state, isDraft: pr.isDraft },
      reviews: [{ name: "alice", state: "approved" }],
      checks: [{ name: "build", state: "passed" }],
    },
  ]);
  expect(result.refreshedAt).toBeString();
  expect(JSON.stringify(result)).not.toContain("/private");
});

test("distinguishes no PR, ambiguous matches, unavailable PRs and partial stale reads", async () => {
  const noPr = await projectWorktrees(
    "/private/project",
    dependencies({ find: async (branch) => (branch === "main" ? [] : [pr.ref, pr.ref]) }),
  );
  expect(noPr.worktrees.map(({ state }) => state)).toEqual(["no-pr", "ambiguous"]);

  const failed = await projectWorktrees(
    "/private/project",
    dependencies({
      getPullRequest: async () => {
        throw new ScmError("SCM_ACCESS_DENIED", "secret detail");
      },
    }),
  );
  expect(failed.worktrees[0]).toMatchObject({
    state: "unavailable",
    failure: "access-denied",
  });
  expect(JSON.stringify(failed)).not.toContain("secret detail");

  const partial = await projectWorktrees(
    "/private/project",
    dependencies({
      getChecks: async () => {
        throw new Error("secret provider response");
      },
    }),
  );
  expect(partial.worktrees[0]).toMatchObject({
    state: "available",
    pr: { state: "merged" },
    reviews: [{ state: "approved" }],
    failure: "provider",
  });
  expect(partial.worktrees[0]).not.toHaveProperty("checks");
});

test("marks Azure and ambiguous repositories unsupported instead of claiming no PR", async () => {
  const azure = await projectWorktrees(
    "/private/project",
    dependencies({
      repositories: ["origin"],
      remoteUrl: () => "https://dev.azure.com/acme/project/_git/app",
    }),
  );
  expect(azure.worktrees.map(({ state }) => state)).toEqual(["unsupported", "unsupported"]);

  const ambiguous = await projectWorktrees(
    "/private/project",
    dependencies({
      repositories: ["origin", "upstream"],
      remoteUrl: (name) =>
        name === "origin" ? "git@github.com:acme/app.git" : "git@github.com:other/app.git",
    }),
  );
  expect(ambiguous.worktrees.map(({ state }) => state)).toEqual(["ambiguous", "ambiguous"]);

  const invalidRemote = await projectWorktrees(
    "/private/project",
    dependencies({ remoteUrl: () => "/private/mirror.git" }),
  );
  expect(invalidRemote.worktrees.map(({ state }) => state)).toEqual(["unsupported", "unsupported"]);
});

test("sanitizes credential failures and retains worktree branch identities", async () => {
  const createProvider = mock(async () => {
    throw new ScmError("SCM_AUTHENTICATION_FAILED", "secret-token");
  });
  const result = await projectWorktrees(
    "/private/project",
    dependencies({ providerCreate: createProvider }),
  );

  expect(result.worktrees[1]).toMatchObject({
    name: "topic",
    branch: "topic",
    state: "unavailable",
    failure: "authentication",
  });
  expect(JSON.stringify(result)).not.toContain("secret-token");
  expect(createProvider).toHaveBeenCalledTimes(1);
});
