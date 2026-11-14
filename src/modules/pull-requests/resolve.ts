import { GitModule } from "../git/git.module";
import { ScmError } from "./errors";
import type { PullRequestProvider, PullRequestRef, RepositoryRef } from "./provider";
import {
  parsePrNumber,
  parsePullRequestUrl,
  parseRemoteUrl,
  parseRepositoryUrl,
  refForNumber,
  repositoryKey,
  repositoryUrl,
} from "./targets";

export interface PullRequestInput {
  ref?: string;
  repo?: string;
  remote?: string;
  head?: string;
}

export interface GitContext {
  remotes(): Promise<{ name: string; url: string }[]>;
  branch(): Promise<string | undefined>;
}

export type ResolvedLookup = {
  repository: RepositoryRef;
} & ({ kind: "exact"; ref: PullRequestRef } | { kind: "branch"; sourceBranch: string });

export async function resolvePullRequestTarget(
  lookup: ResolvedLookup,
  provider: PullRequestProvider,
): Promise<{ provider: PullRequestProvider; ref: PullRequestRef }> {
  if (lookup.kind === "exact") return { provider, ref: lookup.ref };

  const candidates = await provider.findOpenPullRequests({
    repository: lookup.repository,
    sourceBranch: lookup.sourceBranch,
  });
  if (candidates.length === 0)
    throw new ScmError("SCM_NOT_FOUND", "No open PR was found for the selected source branch.");

  if (candidates.length > 1) {
    const repositoryBaseUrl = repositoryUrl(lookup.repository);
    const urls = candidates.map((ref) => {
      const path = ref.provider === "github" ? `pull/${ref.number}` : `pullrequest/${ref.id}`;

      return `${repositoryBaseUrl}/${path}`;
    });
    const candidateUrls = urls.join("\n");
    const message = `Multiple open PRs match. Supply an exact PR number or URL:\n${candidateUrls}`;
    throw new ScmError("SCM_AMBIGUOUS_PULL_REQUEST", message);
  }

  return { provider, ref: candidates[0]! };
}

export async function resolvePullRequestLookup(
  input: PullRequestInput,
  git: GitContext,
): Promise<ResolvedLookup> {
  validateInput(input);

  const explicit = await explicitRepository(input, git);
  if (input.ref?.includes("://")) {
    const parsed = parsePullRequestUrl(input.ref);
    if (explicit && repositoryKey(explicit) !== repositoryKey(parsed.repository))
      throw new ScmError(
        "SCM_CONFLICTING_INPUT",
        "The PR URL and explicit repository selection identify different repositories.",
      );

    return { kind: "exact", ...parsed };
  }

  const number = input.ref ? parsePrNumber(input.ref) : undefined;
  const repository = explicit ?? (await inferredRepository(git));
  if (number !== undefined)
    return { kind: "exact", repository, ref: refForNumber(repository, number) };

  const sourceBranch = (input.head ?? (await git.branch()))?.replace(/^refs\/heads\//, "");
  if (
    !sourceBranch ||
    [...sourceBranch].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new ScmError(
      "SCM_BRANCH_REQUIRED",
      "Supply a PR number/URL or --head, or run from a Git repository with a checked-out branch.",
    );

  return { kind: "branch", repository, sourceBranch };
}

export async function resolveRepository(
  input: Pick<PullRequestInput, "repo" | "remote">,
  git: GitContext,
): Promise<RepositoryRef> {
  if (input.repo !== undefined && input.remote !== undefined)
    throw new ScmError("SCM_CONFLICTING_INPUT", "Choose either --repo or --remote, not both.");
  if (input.repo === "" || input.remote === "")
    throw new ScmError("SCM_INVALID_OPTIONS", "Repository selectors must not be empty.");

  return (await explicitRepository(input, git)) ?? (await inferredRepository(git));
}

function validateInput(input: PullRequestInput): void {
  if (input.repo && input.remote)
    throw new ScmError("SCM_CONFLICTING_INPUT", "Choose either --repo or --remote, not both.");
  if (input.ref && input.head)
    throw new ScmError(
      "SCM_CONFLICTING_INPUT",
      "Choose either a PR reference or --head, not both.",
    );
}

async function explicitRepository(
  input: PullRequestInput,
  git: GitContext,
): Promise<RepositoryRef | undefined> {
  if (input.repo) return parseRepositoryUrl(input.repo);
  if (input.remote) return selectedRemote(input.remote, git);
}

export function createGitContext(cwd: string): GitContext {
  return {
    async remotes() {
      let names: string;
      try {
        names = await GitModule.execute(cwd, ["remote"]);
      } catch {
        throw new ScmError(
          "SCM_REPOSITORY_REQUIRED",
          "Cannot read local Git remotes. Supply --repo with a repository URL.",
        );
      }

      return Promise.all(
        names
          .split("\n")
          .filter(Boolean)
          .map(async (name) => ({
            name,
            url: await GitModule.execute(cwd, ["remote", "get-url", "--", name]),
          })),
      );
    },
    async branch() {
      try {
        return (await GitModule.execute(cwd, ["branch", "--show-current"])) || undefined;
      } catch {
        return undefined;
      }
    },
  };
}

async function selectedRemote(name: string, git: GitContext): Promise<RepositoryRef> {
  const remote = (await git.remotes()).find((remote) => remote.name === name);
  if (!remote)
    throw new ScmError("SCM_REMOTE_NOT_FOUND", "The selected Git remote does not exist.");

  try {
    return parseRemoteUrl(remote.url);
  } catch {
    throw new ScmError(
      "SCM_UNSUPPORTED_REMOTE",
      "The selected remote is not a supported GitHub or Azure DevOps Services repository.",
    );
  }
}

async function inferredRepository(git: GitContext): Promise<RepositoryRef> {
  const candidates = new Map<string, RepositoryRef>();
  for (const remote of await git.remotes()) {
    try {
      const repository = parseRemoteUrl(remote.url);
      candidates.set(repositoryKey(repository), repository);
    } catch {}
  }
  if (candidates.size === 0)
    throw new ScmError(
      "SCM_REPOSITORY_REQUIRED",
      "No supported Git remote was found. Supply --repo with a repository URL.",
    );
  if (candidates.size > 1)
    throw new ScmError(
      "SCM_AMBIGUOUS_REPOSITORY",
      `Multiple repositories were found. Choose --remote or --repo:\n${[...candidates.values()].map(repositoryUrl).join("\n")}`,
    );

  return [...candidates.values()][0]!;
}
