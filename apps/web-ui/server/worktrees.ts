import { basename } from "node:path";

import { GitModule } from "../../../src/modules/git/git.module";
import { ScmError } from "../../../src/modules/pull-requests/errors";
import { createPullRequestProvider } from "../../../src/modules/pull-requests/factory";
import type {
  PullRequestProvider,
  PullRequestRef,
  RepositoryRef,
} from "../../../src/modules/pull-requests/provider";
import { parseRemoteUrl, repositoryKey } from "../../../src/modules/pull-requests/targets";

export type WorktreePullRequestState =
  | "no-branch"
  | "no-pr"
  | "ambiguous"
  | "unsupported"
  | "unavailable"
  | "available";

export type WorktreeProjection = {
  name: string;
  branch: string | null;
  state: WorktreePullRequestState;
  failure?: "authentication" | "access-denied" | "provider";
  stale?: boolean;
  pr?: {
    ref: PullRequestRef;
    title: string;
    url: string;
    state: "open" | "closed" | "merged";
    isDraft: boolean;
  };
  reviews?: { name: string; state: string }[];
  checks?: { name: string; state: string; url?: string }[];
};

export async function projectWorktrees(
  repositoryPath: string,
  dependencies: {
    worktrees?: typeof GitModule.worktrees;
    remotes?: typeof GitModule.execute;
    createProvider?: typeof createPullRequestProvider;
  } = {},
): Promise<{ worktrees: WorktreeProjection[]; refreshedAt: string }> {
  const readWorktrees = dependencies.worktrees ?? GitModule.worktrees;
  const readGit = dependencies.remotes ?? GitModule.execute;
  const createProvider = dependencies.createProvider ?? createPullRequestProvider;
  const worktrees = await readWorktrees(repositoryPath);
  const discovery = await discoverRepositories(repositoryPath, readGit);
  const repositories = discovery.repositories;
  const refreshedAt = new Date().toISOString();
  if (discovery.unsupported)
    return {
      worktrees: worktrees.map((worktree) => ({
        name: basename(worktree.path),
        branch: worktree.branch,
        state: "unsupported",
      })),
      refreshedAt,
    };

  if (repositories.length !== 1)
    return {
      worktrees: worktrees.map((worktree) => ({
        name: basename(worktree.path),
        branch: worktree.branch,
        state: repositories.length === 0 ? "unsupported" : "ambiguous",
      })),
      refreshedAt,
    };

  const repository = repositories[0]!;
  if (repository.provider !== "github")
    return {
      worktrees: worktrees.map((worktree) => ({
        name: basename(worktree.path),
        branch: worktree.branch,
        state: "unsupported",
      })),
      refreshedAt,
    };

  let provider: PullRequestProvider;
  try {
    provider = await createProvider(repository);
  } catch (error) {
    const failure = failureCategory(error);
    return {
      worktrees: worktrees.map((worktree) => ({
        name: basename(worktree.path),
        branch: worktree.branch,
        state: worktree.branch ? "unavailable" : "no-branch",
        ...(worktree.branch ? { failure } : {}),
      })),
      refreshedAt,
    };
  }

  const projected = await Promise.all(
    worktrees.map((worktree) => projectWorktree(worktree, repository, provider)),
  );

  return { worktrees: projected, refreshedAt };
}

async function discoverRepositories(
  cwd: string,
  execute: typeof GitModule.execute,
): Promise<{ repositories: RepositoryRef[]; unsupported: boolean }> {
  const remotes = (await execute(cwd, ["remote"])).split("\n").filter(Boolean);
  const repositories = new Map<string, RepositoryRef>();
  let unsupported = false;
  for (const remote of remotes) {
    const url = await execute(cwd, ["remote", "get-url", "--", remote]);
    try {
      const repository = parseRemoteUrl(url);
      repositories.set(repositoryKey(repository), repository);
    } catch {
      unsupported = true;
    }
  }

  return { repositories: [...repositories.values()], unsupported };
}

async function projectWorktree(
  worktree: { path: string; branch: string | null },
  repository: Extract<RepositoryRef, { provider: "github" }>,
  provider: PullRequestProvider,
): Promise<WorktreeProjection> {
  if (!worktree.branch) return { name: basename(worktree.path), branch: null, state: "no-branch" };
  const base = { name: basename(worktree.path), branch: worktree.branch };
  if (
    !("findPullRequestsBySourceBranch" in provider) ||
    typeof provider.findPullRequestsBySourceBranch !== "function"
  )
    return { ...base, state: "unsupported" };

  try {
    const refs = await provider.findPullRequestsBySourceBranch({
      repository,
      sourceBranch: worktree.branch,
    });
    if (refs.length === 0) return { ...base, state: "no-pr" };
    if (refs.length > 1) return { ...base, state: "ambiguous" };
    return await readPullRequest(provider, refs[0]!, base);
  } catch (error) {
    return { ...base, state: "unavailable", failure: failureCategory(error) };
  }
}

async function readPullRequest(
  provider: PullRequestProvider,
  ref: PullRequestRef,
  base: { name: string; branch: string },
): Promise<WorktreeProjection> {
  try {
    const pr = await provider.getPullRequest(ref);
    const [reviews, checks] = await Promise.allSettled([
      provider.getReviews(ref),
      provider.getChecks(ref),
    ]);
    const reviewValues = reviews.status === "fulfilled" ? reviews.value : undefined;
    const checkValues = checks.status === "fulfilled" ? checks.value : undefined;

    return {
      ...base,
      state: "available",
      pr: { ref, title: pr.title, url: pr.url, state: pr.state, isDraft: pr.isDraft },
      ...(reviewValues
        ? {
            reviews: reviewValues.map((review) => ({
              name: review.reviewer.name,
              state: review.state,
            })),
          }
        : {}),
      ...(checkValues
        ? {
            checks: checkValues.map((check) => ({
              name: check.name,
              state: check.state,
              ...(check.url ? { url: check.url } : {}),
            })),
          }
        : {}),
      ...(reviewValues && checkValues
        ? {}
        : {
            failure: failureCategory(
              reviews.status === "rejected"
                ? reviews.reason
                : checks.status === "rejected"
                  ? checks.reason
                  : undefined,
            ),
          }),
    };
  } catch (error) {
    return { ...base, state: "unavailable", failure: failureCategory(error) };
  }
}

function failureCategory(error: unknown): "authentication" | "access-denied" | "provider" {
  if (!(error instanceof ScmError)) return "provider";
  if (error.code === "SCM_AUTHENTICATION_FAILED") return "authentication";
  if (error.code === "SCM_ACCESS_DENIED") return "access-denied";

  return "provider";
}
