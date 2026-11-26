import type { WorktreeProjection } from "@/pages/worktrees";
import type { ConversationSummary } from "@/pages/conversations";

export function WorktreeCard({
  worktree,
  conversations,
  selected,
  onSelect,
}: {
  worktree: WorktreeProjection;
  conversations: ConversationSummary[];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <article
      className={`mb-1 overflow-hidden rounded-md border px-1.5 py-1 ${
        selected
          ? "border-sidebar-border bg-sidebar-accent/70 text-sidebar-accent-foreground"
          : "border-transparent"
      }`}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Open ${worktree.name}${worktree.branch ? ` on ${worktree.branch}` : ""} in Doing`}
        onClick={onSelect}
        className="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="shrink-0 text-muted-foreground" aria-hidden="true">
          <WorktreeIcon />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{worktree.name}</span>
        {worktree.stale ? <span className="size-1.5 shrink-0 rounded-full bg-attention" /> : null}
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatAge(latestActivity(conversations))}
        </span>
      </button>
      <WorktreeDescription worktree={worktree} />
      {worktree.pr ? <WorktreePullRequest worktree={worktree} /> : null}
      <ConversationList conversations={conversations} />
    </article>
  );
}

function WorktreeDescription({ worktree }: { worktree: WorktreeProjection }) {
  const description = worktree.branch ?? (worktree.failure ? failureLabel(worktree.failure) : null);
  return description ? (
    <p className="truncate px-7 pb-1 text-[10px] text-muted-foreground">{description}</p>
  ) : null;
}

function WorktreePullRequest({ worktree }: { worktree: WorktreeProjection }) {
  if (!worktree.pr) return null;
  const number = worktree.pr.ref.provider === "github" ? `#${worktree.pr.ref.number}` : undefined;
  const externalUrl = safeGitHubUrl(worktree.pr.url);
  const status = [
    worktree.pr.state,
    worktree.pr.isDraft ? "draft" : undefined,
    worktree.reviews?.length
      ? `${worktree.reviews.length} review${worktree.reviews.length === 1 ? "" : "s"}`
      : undefined,
    worktree.checks?.length
      ? `CI ${summarizeChecks(worktree.checks.map((check) => check.state))}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <p className="truncate px-7 pb-1 text-[10px] text-muted-foreground">
        {externalUrl ? (
          <a href={externalUrl} target="_blank" rel="noreferrer" className="hover:text-foreground">
            {number} · {worktree.pr.title}
          </a>
        ) : (
          `${number} · ${worktree.pr.title}`
        )}
      </p>
      <p className="truncate px-7 pb-1 text-[10px] text-muted-foreground">{status}</p>
    </>
  );
}

function ConversationList({ conversations }: { conversations: ConversationSummary[] }) {
  if (!conversations.length) return null;

  return (
    <ul className="space-y-px pb-0.5 pl-5">
      {conversations.map((conversation) => (
        <li
          key={conversation.id}
          className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-[11px]"
          title={conversation.title || "New conversation"}
        >
          <ConversationStatusIcon status={conversation.status} />
          <span className="min-w-0 flex-1 truncate text-sidebar-foreground/80">
            {conversation.title || "New conversation"}
          </span>
          {conversation.model ? (
            <span className="max-w-16 shrink-0 truncate text-[10px] text-muted-foreground">
              {conversation.model}
            </span>
          ) : null}
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {formatAge(conversation.updatedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function WorktreeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
      <path
        d="M4 2.5v11M4 5h6a2 2 0 0 1 2 2v.5M4 11h6a2 2 0 0 0 2-2v-.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="4" cy="2.5" r="1" fill="currentColor" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" />
      <circle cx="12" cy="8.5" r="1" fill="currentColor" />
    </svg>
  );
}

function ConversationStatusIcon({ status }: { status: ConversationSummary["status"] }) {
  const color =
    status === "active"
      ? "bg-blue-400"
      : status === "blocked"
        ? "bg-amber-400"
        : status === "incomplete"
          ? "bg-red-400"
          : "bg-muted-foreground/50";

  return (
    <span
      role="img"
      aria-label={status}
      title={status}
      className={`size-1.5 shrink-0 rounded-full ${color}`}
    />
  );
}

function summarizeChecks(states: string[]) {
  if (states.some((state) => state === "failed" || state === "cancelled")) return "failing";
  if (states.some((state) => state === "pending" || state === "running" || state === "unknown"))
    return "pending";
  return "passing";
}

function latestActivity(conversations: ConversationSummary[]) {
  return conversations.reduce(
    (latest, conversation) => Math.max(latest, conversation.updatedAt),
    0,
  );
}

function failureLabel(failure: NonNullable<WorktreeProjection["failure"]>) {
  if (failure === "authentication") return "Provider authentication required";
  if (failure === "access-denied") return "Provider access denied";

  return "Provider data incomplete";
}
function formatAge(timestamp: number) {
  if (!timestamp) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function safeGitHubUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "github.com") return url.href;
  } catch {}
}
