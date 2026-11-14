import type {
  PullRequest,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDiff,
  PullRequestListItem,
  PullRequestReview,
  PullRequestCommentThreads,
} from "../../../../src/modules/pull-requests/provider";

export function formatPullRequestListItem(pr: PullRequestListItem): string {
  const identifier = pr.ref.provider === "github" ? `#${pr.ref.number}` : pr.ref.id;
  const draftLabel = pr.isDraft ? " (draft)" : "";

  return `${identifier}\t${pr.state}${draftLabel}\t${pr.title}\n${pr.url}`;
}

export function formatPullRequestDetails(pr: PullRequest): string {
  const draftLabel = pr.isDraft ? " (draft)" : "";
  const body = pr.body ? `\n\n${pr.body}` : "";
  const sections = [
    `${pr.title}\n${pr.state}${draftLabel} · ${pr.sourceBranch} → ${pr.targetBranch}\n${pr.url}${body}`,
  ];

  if (pr.comments) {
    const comments = pr.comments.map(formatComment).join("\n\n") || "No comments.";
    sections.push("Comments", comments);
  }

  if (pr.checks) {
    sections.push("Checks", formatChecks(pr.checks));
  }

  if (pr.raw !== undefined) {
    sections.push("Raw provider data", JSON.stringify(pr.raw, null, 2));
  }

  return sections.join("\n\n");
}

export function formatChecks(checks: readonly PullRequestCheck[]): string {
  return (
    checks
      .map((check) => {
        const url = check.url ? `\t${check.url}` : "";
        return `${check.state}\t${check.name}${url}`;
      })
      .join("\n") || "No checks."
  );
}

export function formatReviews(reviews: readonly PullRequestReview[]): string {
  return (
    reviews.map((review) => `${review.state}\t${review.reviewer.name}`).join("\n") ||
    "No reviewers."
  );
}

export function formatReviewThreads(result: PullRequestCommentThreads): string {
  const threads =
    result.threads.map((thread) => thread.map(formatThreadComment).join("\n\n")).join("\n\n") ||
    "No review threads.";
  const more = result.hasMore ? "\nMore matching threads available; increase --limit." : "";
  const incomplete = result.incomplete
    ? "\nOne or more threads have more than 100 comments; replies are omitted."
    : "";

  return `${threads}${more}${incomplete}`;
}

export function formatDiffOutput(
  format: string | undefined,
  data: { diff: PullRequestDiff },
  diff: PullRequestDiff,
): string {
  if (format === "json") return JSON.stringify(data, null, 2);
  if (format === "stat") return formatDiffStat(diff);
  return formatDiffPatch(diff);
}

function formatDiffStat(diff: PullRequestDiff): string {
  const files = diff.files.map(
    (file) => `${quoteGitPath(file.path)} | +${file.additions} -${file.deletions} (${file.status})`,
  );
  const additions = diff.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = diff.files.reduce((sum, file) => sum + file.deletions, 0);
  const summary = `${diff.files.length} file(s) changed, ${additions} insertions(+), ${deletions} deletions(-)`;
  const lines = [...files];

  lines.push(files.length ? summary : "No changed files.");
  if (diff.completeness.status === "incomplete") {
    lines.push(`Incomplete file list: ${diff.completeness.reason}`);
  }

  return lines.join("\n");
}

function formatDiffPatch(diff: PullRequestDiff): string {
  const files = diff.files.map(formatDiffFile);
  const lines = [...files];

  if (files.length === 0) lines.push("No changed files.");
  if (diff.completeness.status === "incomplete") {
    lines.push(`# Incomplete file list: ${diff.completeness.reason}`);
  }

  return lines.join("\n");
}

function formatComment(comment: PullRequestComment): string {
  const author = comment.author?.name ?? "Deleted user";
  const location = formatCommentLocation(comment);
  return `${author}${location}\n${comment.body}`;
}

function formatThreadComment(comment: PullRequestComment): string {
  const reply = comment.replyTo ? ` · reply-to ${comment.replyTo}` : "";
  const resolution = comment.isResolved ? " (resolved)" : " (unresolved)";
  const author = comment.author?.name ?? "Deleted user";
  const location = formatCommentLocation(comment);
  return `${comment.id}${reply}${resolution}\n${author}${location}\n${comment.body}`;
}

function formatCommentLocation(comment: PullRequestComment): string {
  if (!comment.path) return "";
  const line = comment.line ? `:${comment.line}` : "";
  return ` · ${comment.path}${line}`;
}

function formatDiffFile(file: PullRequestDiff["files"][number]): string {
  if (file.patch.status === "unavailable") {
    return `# Patch unavailable (${file.patch.reason}) for ${quoteGitPath(file.path)}`;
  }

  const previousPath = file.previousPath ?? file.path;
  const oldPath = quoteGitPath(`a/${previousPath}`);
  const newPath = quoteGitPath(`b/${file.path}`);
  const header = `diff --git ${oldPath} ${newPath}`;
  const oldLabel = file.status === "added" ? "/dev/null" : oldPath;
  const newLabel = file.status === "deleted" ? "/dev/null" : newPath;
  const labels = `--- ${oldLabel}\n+++ ${newLabel}`;
  const note =
    file.patch.status === "truncated" ? `# Patch truncated for ${quoteGitPath(file.path)}\n` : "";

  return `${header}\n${note}${labels}\n${file.patch.text}`;
}

function quoteGitPath(path: string): string {
  let quoted = '"';
  const bytes = new TextEncoder().encode(path);

  for (const byte of bytes) {
    if (byte === 0x22) quoted += '\\"';
    else if (byte === 0x5c) quoted += "\\\\";
    else if (byte === 0x09) quoted += "\\t";
    else if (byte === 0x0a) quoted += "\\n";
    else if (byte === 0x0d) quoted += "\\r";
    else if (byte < 0x20 || byte > 0x7e) quoted += `\\${byte.toString(8).padStart(3, "0")}`;
    else quoted += String.fromCharCode(byte);
  }

  return `${quoted}"`;
}
