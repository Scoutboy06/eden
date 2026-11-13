import type { Octokit } from "@octokit/rest";
import { invalidResponse, providerRequest } from "../../modules/pull-requests/errors";
import type {
  PullRequestComment,
  PullRequestCommentThreadsQuery,
  PullRequestRef,
} from "../../modules/pull-requests/provider";

export function listReviewThreads(
  client: Octokit,
  ref: Extract<PullRequestRef, { provider: "github" }>,
  query: PullRequestCommentThreadsQuery,
) {
  return providerRequest(async () => {
    const threads: PullRequestComment[][] = [];
    let cursor: string | null = null;
    let hasMore = false;
    let incomplete = false;
    do {
      hasMore = false;
      const response: unknown = await client.graphql(threadQuery, {
        owner: ref.owner,
        repo: ref.repository,
        number: ref.number,
        cursor,
      });
      const page = normalizePage(response);
      incomplete ||= page.incomplete;
      for (const thread of page.threads) {
        if (!matchesThread(thread, query)) continue;
        if (threads.length === query.limit) {
          hasMore = true;
          break;
        }
        threads.push(thread);
      }
      if (hasMore) break;
      cursor = page.endCursor;
      hasMore = page.hasNextPage;
    } while (cursor);

    return { threads, hasMore, incomplete };
  });
}

function matchesThread(thread: PullRequestComment[], query: PullRequestCommentThreadsQuery) {
  if (query.unresolved && thread[0]?.isResolved) return false;

  return (
    query.since === undefined ||
    thread.some((comment) => Date.parse(comment.createdAt ?? "") >= Date.parse(query.since!))
  );
}

const threadQuery = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes { id isResolved comments(first: 100) { nodes { databaseId body createdAt path line originalLine user { databaseId login } replyTo { databaseId } } pageInfo { hasNextPage } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

function normalizePage(response: unknown): {
  threads: PullRequestComment[][];
  hasNextPage: boolean;
  endCursor: string | null;
  incomplete: boolean;
} {
  const connection = readConnection(response);
  const pageInfo = readPageInfo(connection.pageInfo);

  return {
    threads: connection.nodes.map((thread) => normalizeThread(thread)),
    ...pageInfo,
    incomplete: connection.nodes.some(hasMoreThreadComments),
  };
}

function readConnection(response: unknown): { nodes: unknown[]; pageInfo: unknown } {
  if (typeof response !== "object" || response === null || !("repository" in response))
    invalidResponse();
  const repository = response.repository;
  if (typeof repository !== "object" || repository === null || !("pullRequest" in repository))
    invalidResponse();
  const pullRequest = repository.pullRequest;
  if (typeof pullRequest !== "object" || pullRequest === null || !("reviewThreads" in pullRequest))
    invalidResponse();
  const connection = pullRequest.reviewThreads;
  if (
    typeof connection !== "object" ||
    connection === null ||
    !("nodes" in connection) ||
    !Array.isArray(connection.nodes) ||
    !("pageInfo" in connection)
  )
    invalidResponse();

  return connection as { nodes: unknown[]; pageInfo: unknown };
}

function readPageInfo(value: unknown): { hasNextPage: boolean; endCursor: string | null } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("hasNextPage" in value) ||
    typeof value.hasNextPage !== "boolean" ||
    !("endCursor" in value)
  )
    invalidResponse();
  if (value.endCursor !== null && typeof value.endCursor !== "string") invalidResponse();

  return { hasNextPage: value.hasNextPage, endCursor: value.endCursor };
}

function normalizeThread(thread: any): PullRequestComment[] {
  if (
    typeof thread.id !== "string" ||
    typeof thread.isResolved !== "boolean" ||
    !Array.isArray(thread.comments?.nodes) ||
    typeof thread.comments?.pageInfo?.hasNextPage !== "boolean"
  )
    invalidResponse();

  return thread.comments.nodes.map((comment: any) => normalizeComment(comment, thread));
}

function hasMoreThreadComments(thread: any) {
  return thread.comments?.pageInfo?.hasNextPage === true;
}

function normalizeComment(comment: any, thread: any): PullRequestComment {
  if (
    !Number.isSafeInteger(comment.databaseId) ||
    comment.databaseId < 1 ||
    typeof comment.body !== "string" ||
    typeof comment.createdAt !== "string"
  )
    invalidResponse();
  const rootId = comment.replyTo?.databaseId ?? comment.databaseId;

  return {
    id: `review:${comment.databaseId}`,
    body: comment.body,
    author: comment.user
      ? { id: `user:${comment.user.databaseId}`, name: comment.user.login }
      : null,
    createdAt: comment.createdAt,
    ...(comment.path ? { path: comment.path } : {}),
    ...((comment.line ?? comment.originalLine) != null
      ? { line: comment.line ?? comment.originalLine }
      : {}),
    threadId: thread.id,
    isResolved: thread.isResolved,
    ...(Number.isSafeInteger(rootId) && rootId > 0 ? { replyTo: `review:${rootId}` } : {}),
  };
}
