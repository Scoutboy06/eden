import type { Octokit } from "@octokit/rest";
import { ScmError, invalidResponse, providerRequest } from "../../modules/pull-requests/errors";
import type { PullRequestThreadResolution } from "../../modules/pull-requests/provider";
import type { PullRequestRef } from "../../modules/pull-requests/provider";

export function setReviewThreadResolution(
  client: Octokit,
  ref: Extract<PullRequestRef, { provider: "github" }>,
  threadId: string,
  desiredResolution: boolean,
): Promise<PullRequestThreadResolution> {
  return providerRequest(async () => {
    const current = normalizeThread(await client.graphql(threadOwnershipQuery, { threadId }));
    if (
      current.number !== ref.number ||
      current.owner.toLowerCase() !== ref.owner.toLowerCase() ||
      current.repository.toLowerCase() !== ref.repository.toLowerCase()
    )
      throw new ScmError(
        "SCM_INVALID_REFERENCE",
        "The review thread does not belong to the selected pull request.",
      );
    if (current.isResolved === desiredResolution)
      return { threadId, isResolved: desiredResolution, changed: false };

    let result: { id: string; isResolved: boolean };
    try {
      result = normalizeMutation(
        await client.graphql(desiredResolution ? resolveThreadMutation : unresolveThreadMutation, {
          threadId,
        }),
      );
    } catch {
      throw new ScmError(
        "SCM_PARTIAL_FAILURE",
        "The review thread state may have changed; inspect the thread before retrying.",
      );
    }
    if (result.id !== current.id || result.isResolved !== desiredResolution)
      throw new ScmError(
        "SCM_PARTIAL_FAILURE",
        "The review thread may have changed, but GitHub did not confirm the requested state.",
      );

    return { threadId, isResolved: result.isResolved, changed: true };
  });
}

const threadOwnershipQuery = `query($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      id isResolved pullRequest { number repository { name owner { login } } }
    }
  }
}`;

const resolveThreadMutation = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

const unresolveThreadMutation = `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

function normalizeThread(response: unknown) {
  const node = record(record(response)?.node);
  const pullRequest = record(node?.pullRequest);
  const repository = record(pullRequest?.repository);
  const owner = record(repository?.owner);
  const id = node?.id;
  const isResolved = node?.isResolved;
  const number = pullRequest?.number;
  const repositoryName = repository?.name;
  const ownerName = owner?.login;
  if (typeof id !== "string" || typeof isResolved !== "boolean") invalidResponse();
  if (typeof number !== "number" || !Number.isSafeInteger(number)) invalidResponse();
  if (typeof repositoryName !== "string" || typeof ownerName !== "string") invalidResponse();

  return {
    id,
    isResolved,
    number,
    repository: repositoryName,
    owner: ownerName,
  };
}

function normalizeMutation(response: unknown) {
  const payload = record(response);
  const key =
    payload && "resolveReviewThread" in payload ? "resolveReviewThread" : "unresolveReviewThread";
  const thread = record(record(payload?.[key])?.thread);
  const id = thread?.id;
  const isResolved = thread?.isResolved;
  if (typeof id !== "string" || typeof isResolved !== "boolean") invalidResponse();

  return { id, isResolved };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
