import type { Octokit } from "@octokit/rest";
import { invalidResponse } from "../../modules/pull-requests/errors";
import type { PullRequest, PullRequestRef } from "../../modules/pull-requests/provider";

export type GitHubListItem = Awaited<ReturnType<Octokit["pulls"]["list"]>>["data"][number];

export type GitHubPullRequestData =
  | (GitHubListItem & { merged: boolean })
  | Awaited<ReturnType<Octokit["pulls"]["get"]>>["data"]
  | Awaited<ReturnType<Octokit["pulls"]["create"]>>["data"]
  | Awaited<ReturnType<Octokit["pulls"]["update"]>>["data"];

export function normalizePullRequest(
  data: GitHubPullRequestData,
  ref?: PullRequestRef,
): PullRequest {
  if (!data.title || !data.html_url) invalidResponse();
  if (!data.head?.ref) invalidResponse();
  if (!data.base?.ref) invalidResponse();

  const sourceBranch = data.head.ref;
  const targetBranch = data.base.ref;

  let state: PullRequest["state"];
  if (data.merged) {
    state = "merged";
  } else if (data.state === "open") {
    state = "open";
  } else if (data.state === "closed") {
    state = "closed";
  } else {
    invalidResponse();
  }

  const normalizedRef = ref ?? {
    provider: "github" as const,
    owner: data.base.repo?.owner?.login ?? "",
    repository: data.base.repo?.name ?? "",
    number: data.number,
  };

  return {
    ref: normalizedRef,
    url: data.html_url,
    title: data.title,
    body: data.body ?? "",
    state,
    isDraft: data.draft ?? false,
    sourceBranch,
    targetBranch,
  };
}

export function assertPullRequestIdentity(
  result: PullRequest,
  ref: Extract<PullRequestRef, { provider: "github" }>,
) {
  if (result.ref.provider !== "github") invalidResponse();

  const sameNumber = result.ref.number === ref.number;
  const sameOwner = result.ref.owner.toLowerCase() === ref.owner.toLowerCase();
  const sameRepository = result.ref.repository.toLowerCase() === ref.repository.toLowerCase();

  if (!sameNumber || !sameOwner || !sameRepository) invalidResponse();
}
