import type { WorktreeProjection } from "@/pages/worktrees";

export function WorktreeCard({
  worktree,
  selected,
  onSelect,
}: {
  worktree: WorktreeProjection;
  selected: boolean;
  onSelect: () => void;
}) {
  const prNumber =
    worktree.pr?.ref.provider === "github" ? `#${worktree.pr.ref.number}` : undefined;
  const checkState = worktree.checks?.length
    ? summarizeChecks(worktree.checks.map((check) => check.state))
    : undefined;
  const reviewState = worktree.reviews?.length
    ? `${worktree.reviews.length} review${worktree.reviews.length === 1 ? "" : "s"}`
    : undefined;
  const externalUrl = safeGitHubUrl(worktree.pr?.url);

  return (
    <article
      className={`mx-1.5 mb-1.5 overflow-hidden rounded-md border px-2.5 py-2 ${
        selected
          ? "border-sidebar-primary/50 bg-sidebar-accent text-sidebar-accent-foreground"
          : "border-sidebar-border/70"
      }`}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Open ${worktree.name}${worktree.branch ? ` on ${worktree.branch}` : ""} in Doing`}
        onClick={onSelect}
        className="block w-full rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{worktree.name}</span>
          {worktree.stale ? <span className="text-[10px] text-attention">Stale</span> : null}
        </span>
        <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">
          {worktree.branch ?? "Detached HEAD"}
        </span>
        {!worktree.pr ? (
          <span className="mt-1.5 block text-left text-[10px] text-muted-foreground">
            {worktreeStateLabel(worktree)}
          </span>
        ) : null}
        {worktree.failure ? (
          <span className="mt-1 block text-left text-[10px] text-attention">
            {failureLabel(worktree.failure)}
          </span>
        ) : null}
      </button>
      {worktree.pr ? (
        <WorktreePullRequest
          worktree={worktree}
          prNumber={prNumber}
          externalUrl={externalUrl}
          reviewState={reviewState}
          checkState={checkState}
        />
      ) : null}
    </article>
  );
}

function WorktreePullRequest({
  worktree,
  prNumber,
  externalUrl,
  reviewState,
  checkState,
}: {
  worktree: WorktreeProjection;
  prNumber?: string;
  externalUrl?: string;
  reviewState?: string;
  checkState?: string;
}) {
  if (!worktree.pr) return null;

  const title = `${prNumber} · ${worktree.pr.title}`;
  const state = [
    worktree.pr.state,
    worktree.pr.isDraft ? "draft" : undefined,
    reviewState,
    checkState ? `CI ${checkState}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mt-1.5 space-y-1 text-xs">
      <p className="truncate">
        {externalUrl ? (
          <a
            href={externalUrl}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
          >
            {title}
          </a>
        ) : (
          title
        )}
      </p>
      <p className="text-[10px] text-muted-foreground">{state}</p>
    </div>
  );
}

function worktreeStateLabel(worktree: WorktreeProjection) {
  if (worktree.state === "no-branch") return "No checked-out branch";
  if (worktree.state === "no-pr") return "No associated PR";
  if (worktree.state === "ambiguous") return "Multiple matching PRs or repositories";
  if (worktree.state === "unsupported") return "PR provider unsupported";

  return "PR state unavailable";
}

function failureLabel(failure: NonNullable<WorktreeProjection["failure"]>) {
  if (failure === "authentication") return "Provider authentication required";
  if (failure === "access-denied") return "Provider access denied";

  return "Provider data incomplete";
}

function summarizeChecks(states: string[]) {
  if (states.some((state) => state === "failed" || state === "cancelled")) return "failing";
  if (states.some((state) => state === "pending" || state === "running" || state === "unknown"))
    return "pending";

  return "passing";
}

function safeGitHubUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "github.com") return url.href;
  } catch {}
}
