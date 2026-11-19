import {
  CommentThreadStatus,
  CommentType,
  type GitPullRequestCommentThread,
} from "azure-devops-node-api/interfaces/GitInterfaces";
import type {
  PullRequestCommentLocation,
  PullRequestCommentThreads,
  PullRequestCommentThreadsQuery,
} from "../../modules/pull-requests/provider";
import { normalizeComments } from "./normalize";
import type { AzureGitClient } from "./provider";

export async function listAzureCommentThreads(
  git: AzureGitClient,
  repository: string,
  id: number,
  project: string,
  query: PullRequestCommentThreadsQuery,
): Promise<PullRequestCommentThreads> {
  const since = query.since === undefined ? undefined : Date.parse(query.since);
  const threads = (await git.getThreads(repository, id, project))
    .filter((thread) => !thread.isDeleted && (!query.unresolved || isUnresolved(thread)))
    .flatMap((thread) => {
      const source = (thread.comments ?? []).filter(
        (comment) => !comment.isDeleted && comment.commentType === CommentType.Text,
      );
      const comments = normalizeComments([{ ...thread, comments: source }]);
      if (comments.length === 0) return [];

      const latestCommentTime = comments.reduce(
        (latest, comment) => Math.max(latest, Date.parse(comment.createdAt ?? "") || 0),
        Number.NEGATIVE_INFINITY,
      );
      if (
        since !== undefined &&
        !comments.some((comment) => Date.parse(comment.createdAt ?? "") >= since)
      )
        return [];

      return [{ thread, source, comments, latestCommentTime }];
    })
    .sort((left, right) => right.latestCommentTime - left.latestCommentTime);

  const selected = threads.slice(0, query.limit);
  const positions = selected.some(
    ({ thread }) =>
      thread.threadContext?.filePath ||
      thread.pullRequestThreadContext?.trackingCriteria?.origFilePath,
  )
    ? await readTrackedThreads(git, repository, id, project)
    : undefined;

  return {
    threads: selected.map(({ thread, source, comments }) => {
      const current = positions?.threads.get(thread.id);
      const location = threadLocations(thread, current, positions?.iteration);
      const status = thread.status;
      const isResolved =
        status == null || status === CommentThreadStatus.Unknown
          ? undefined
          : !isUnresolved(thread);

      return comments.map((comment, index) => {
        const parentId = source[index]?.parentCommentId;
        const primary = location?.tracked ?? location?.original;
        return {
          ...comment,
          path: primary?.path,
          line: primary?.right?.start?.line ?? primary?.left?.start?.line,
          isResolved,
          ...(parentId != null && parentId > 0 ? { replyTo: `${thread.id}:${parentId}` } : {}),
          ...(location ? { location } : {}),
        };
      });
    }),
    hasMore: threads.length > query.limit,
    incomplete: false,
  };
}

function isUnresolved(thread: GitPullRequestCommentThread): boolean {
  return (
    thread.status === CommentThreadStatus.Active || thread.status === CommentThreadStatus.Pending
  );
}

async function readTrackedThreads(
  git: AzureGitClient,
  repository: string,
  id: number,
  project: string,
) {
  try {
    const iterations = await git.getPullRequestIterations(repository, id, project);
    const iteration = iterations.reduce((latest, item) => Math.max(latest, item.id ?? 0), 0);
    if (!iteration) return;

    const threads = await git.getThreads(repository, id, project, iteration);
    return {
      iteration,
      threads: new Map(
        threads.filter((thread) => !thread.isDeleted).map((thread) => [thread.id, thread]),
      ),
    };
  } catch {
    return;
  }
}

function threadLocations(
  thread: GitPullRequestCommentThread,
  current: GitPullRequestCommentThread | undefined,
  iteration: number | undefined,
) {
  const context = current?.pullRequestThreadContext ?? thread.pullRequestThreadContext;
  const original = originalLocation(thread, current);
  const rightIteration =
    current?.pullRequestThreadContext?.trackingCriteria?.secondComparingIteration ||
    current?.pullRequestThreadContext?.iterationContext?.secondComparingIteration;
  const tracked =
    current && rightIteration === iteration && iteration !== undefined
      ? threadLocation(current.threadContext)
      : undefined;
  if (!original && !tracked) return;

  return {
    ...(tracked ? { tracked } : {}),
    ...(original ? { original } : {}),
    iterationContext: context?.iterationContext,
    trackingCriteria: trackingDetails(context),
  };
}

function trackingDetails(context: GitPullRequestCommentThread["pullRequestThreadContext"]) {
  const tracking = context?.trackingCriteria;
  const changeTrackingId = context?.changeTrackingId;
  if (!tracking && changeTrackingId == null) return;

  return {
    firstComparingIteration: tracking?.firstComparingIteration,
    secondComparingIteration: tracking?.secondComparingIteration,
    changeTrackingId,
    origFilePath: tracking?.origFilePath,
  };
}

function originalLocation(
  thread: GitPullRequestCommentThread,
  current: GitPullRequestCommentThread | undefined,
): PullRequestCommentLocation | undefined {
  const tracking =
    current?.pullRequestThreadContext?.trackingCriteria ??
    thread.pullRequestThreadContext?.trackingCriteria;
  const original = thread.pullRequestThreadContext?.trackingCriteria
    ? undefined
    : threadLocation(thread.threadContext);
  if (!tracking) return original;

  const left =
    tracking.origLeftFileStart || tracking.origLeftFileEnd
      ? { start: tracking.origLeftFileStart, end: tracking.origLeftFileEnd }
      : undefined;
  const right =
    tracking.origRightFileStart || tracking.origRightFileEnd
      ? { start: tracking.origRightFileStart, end: tracking.origRightFileEnd }
      : undefined;
  if (!tracking.origFilePath && !left && !right) return original;

  return { path: tracking.origFilePath ?? original?.path, left, right };
}

function threadLocation(
  context: GitPullRequestCommentThread["threadContext"],
): PullRequestCommentLocation | undefined {
  if (!context?.filePath) return;

  return {
    path: context.filePath,
    ...(context.leftFileStart || context.leftFileEnd
      ? { left: { start: context.leftFileStart, end: context.leftFileEnd } }
      : {}),
    ...(context.rightFileStart || context.rightFileEnd
      ? { right: { start: context.rightFileStart, end: context.rightFileEnd } }
      : {}),
  };
}
