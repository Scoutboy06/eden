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
    } while (cursor);

    return { threads, hasMore, incomplete };
  });
}

function matchesThread(thread: PullRequestComment[], query: PullRequestCommentThreadsQuery) {
  const rootComment = thread[0];
  const isResolved = rootComment?.isResolved ?? false;
  if (query.unresolved && isResolved) return false;
  if (query.since === undefined) return true;

  const since = Date.parse(query.since);
  return thread.some((comment) => Date.parse(comment.createdAt ?? "") >= since);
}

const threadQuery = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes {
              databaseId
              body
              createdAt
              path
              line
              originalLine
              user { databaseId login }
              replyTo { databaseId }
            }
            pageInfo { hasNextPage }
          }
        }
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
  if (typeof response !== "object" || response === null || !("repository" in response)) {
    invalidResponse();
  }

  const repository = response.repository;
  if (typeof repository !== "object" || repository === null || !("pullRequest" in repository)) {
    invalidResponse();
  }

  const pullRequest = repository.pullRequest;
  if (
    typeof pullRequest !== "object" ||
    pullRequest === null ||
    !("reviewThreads" in pullRequest)
  ) {
    invalidResponse();
  }

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
  ) {
    invalidResponse();
  }

  if (value.endCursor !== null && typeof value.endCursor !== "string") {
    invalidResponse();
  }
  if (value.hasNextPage && value.endCursor === null) {
    invalidResponse();
  }

  return { hasNextPage: value.hasNextPage, endCursor: value.endCursor };
}

function normalizeThread(thread: any): PullRequestComment[] {
  const hasValidIdentity = typeof thread.id === "string";
  const hasValidResolution = typeof thread.isResolved === "boolean";
  const comments = thread.comments;
  const hasValidComments = Array.isArray(comments?.nodes);
  const hasValidPageInfo = typeof comments?.pageInfo?.hasNextPage === "boolean";
  if (!hasValidIdentity || !hasValidResolution || !hasValidComments || !hasValidPageInfo)
    invalidResponse();

  return comments.nodes.map((comment: any) => normalizeComment(comment, thread));
}

function hasMoreThreadComments(thread: any) {
  const hasNextPage = thread.comments?.pageInfo?.hasNextPage;
  return hasNextPage === true;
}

function normalizeComment(comment: any, thread: any): PullRequestComment {
  if (!isValidComment(comment)) invalidResponse();
  const replyToId = comment.replyTo?.databaseId;
  const rootId = replyToId ?? comment.databaseId;
  const author = comment.user
    ? { id: `user:${comment.user.databaseId}`, name: comment.user.login }
    : null;
  const normalized: PullRequestComment = {
    id: `review:${comment.databaseId}`,
    body: comment.body,
    author,
    createdAt: comment.createdAt,
    threadId: thread.id,
    isResolved: thread.isResolved,
  };
  if (comment.path) normalized.path = comment.path;

  const line = comment.line ?? comment.originalLine;
  if (line != null) normalized.line = line;

  const hasValidRootId = Number.isSafeInteger(rootId) && rootId > 0;
  if (hasValidRootId) normalized.replyTo = `review:${rootId}`;

  return normalized;
}

function isValidComment(comment: any) {
  const hasValidId = Number.isSafeInteger(comment.databaseId) && comment.databaseId > 0;
  const hasValidBody = typeof comment.body === "string";
  const hasValidTimestamp =
    typeof comment.createdAt === "string" && !Number.isNaN(Date.parse(comment.createdAt));
  const hasValidAuthor = isValidAuthor(comment.user);
  const hasValidReplyTarget = isValidReplyTarget(comment.replyTo);

  return hasValidId && hasValidBody && hasValidTimestamp && hasValidAuthor && hasValidReplyTarget;
}

function isValidAuthor(user: any) {
  if (user === null || user === undefined) return true;

  const hasValidId = Number.isSafeInteger(user.databaseId);
  const hasValidLogin = typeof user.login === "string";
  return hasValidId && hasValidLogin;
}

function isValidReplyTarget(replyTo: any) {
  if (replyTo === null || replyTo === undefined) return true;

  return Number.isSafeInteger(replyTo.databaseId) && replyTo.databaseId > 0;
}
