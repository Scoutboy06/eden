import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpDoubleIcon,
  Bookmark02Icon,
  Bug01Icon,
  Calendar03Icon,
  CheckmarkSquare02Icon,
  EqualSignIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Message01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type IssueType = string;
export type Priority = "highest" | "high" | "medium" | "low" | "P0" | "P1" | "P2" | "P3" | "P4";

/**
 * Pull request linked to an issue. Mirrors `PullRequest` in
 * src/modules/pull-requests/provider.ts, where GitHub and Azure DevOps
 * statuses are normalized to `state` + `isDraft`.
 */
export type IssuePullRequest = {
  provider: "github" | "azure-devops";
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
};

export type PullRequestStatus = "draft" | "open" | "merged" | "closed";

export function pullRequestStatus(pr: IssuePullRequest): PullRequestStatus {
  return pr.state === "open" && pr.isDraft ? "draft" : pr.state;
}

/** Board-flow order for sorting: draft → open → merged → closed. */
export const pullRequestStatusRank: Record<PullRequestStatus, number> = {
  draft: 0,
  open: 1,
  merged: 2,
  closed: 3,
};

const pullRequestMeta = {
  draft: { icon: GitPullRequestDraftIcon, className: "text-muted-foreground" },
  open: { icon: GitPullRequestIcon, className: "text-primary" },
  merged: { icon: GitMergeIcon, className: "text-chart-4" },
  closed: { icon: GitPullRequestClosedIcon, className: "text-destructive" },
} satisfies Record<PullRequestStatus, { icon: unknown; className: string }>;

/** Each provider's own wording for the same status. */
const pullRequestLabels = {
  github: { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" },
  "azure-devops": { draft: "Draft", open: "Active", merged: "Completed", closed: "Abandoned" },
} satisfies Record<IssuePullRequest["provider"], Record<PullRequestStatus, string>>;

const providerMeta = {
  github: { name: "GitHub", prefix: "#" },
  "azure-devops": { name: "Azure DevOps", prefix: "!" },
} satisfies Record<IssuePullRequest["provider"], { name: string; prefix: string }>;

export type Issue = {
  id: string;
  /** Human-readable key, e.g. "EDEN-42". */
  key: string;
  title: string;
  type: IssueType;
  priority: Priority;
  labels?: string[];
  assignee?: { name: string };
  updatedAt?: string;
  /** ISO date (yyyy-mm-dd). */
  dueDate?: string;
  commentCount?: number;
  done?: boolean;
  pullRequest?: IssuePullRequest;
};

const typeMeta = {
  story: { label: "Story", icon: Bookmark02Icon, className: "bg-chart-2/15 text-chart-2" },
  bug: { label: "Bug", icon: Bug01Icon, className: "bg-destructive/15 text-destructive" },
  task: { label: "Task", icon: CheckmarkSquare02Icon, className: "bg-primary/15 text-primary" },
} satisfies Record<string, { label: string; icon: unknown; className: string }>;

const priorityMeta = {
  highest: {
    label: "Highest",
    icon: ArrowUpDoubleIcon,
    className: "text-destructive",
  },
  high: { label: "High", icon: ArrowUp01Icon, className: "text-attention" },
  medium: { label: "Medium", icon: EqualSignIcon, className: "text-muted-foreground" },
  low: { label: "Low", icon: ArrowDown01Icon, className: "text-muted-foreground/70" },
  P0: { label: "P0", icon: ArrowUpDoubleIcon, className: "text-destructive" },
  P1: { label: "P1", icon: ArrowUp01Icon, className: "text-attention" },
  P2: { label: "P2", icon: EqualSignIcon, className: "text-muted-foreground" },
  P3: { label: "P3", icon: ArrowDown01Icon, className: "text-muted-foreground/70" },
  P4: { label: "P4", icon: ArrowDown01Icon, className: "text-muted-foreground/50" },
} satisfies Record<Priority, { label: string; icon: unknown; className: string }>;

const dueFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function isOverdue(dueDate: string) {
  return new Date(`${dueDate}T23:59:59`) < new Date();
}

/** A status column / group of issues, shared by the board, list and table views. */
export type IssueGroup = {
  id: string;
  title: string;
  items: Issue[];
  source?: { label: string; detail: string };
  color?: string;
};

export function IssueTypeIcon({ type }: { type: IssueType }) {
  const meta = Object.hasOwn(typeMeta, type)
    ? typeMeta[type as keyof typeof typeMeta]
    : { ...typeMeta.task, label: type };
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className={cn("grid size-4 shrink-0 place-items-center rounded-sm", meta.className)}
      >
        <HugeiconsIcon icon={meta.icon} strokeWidth={2.5} className="size-3" />
      </TooltipTrigger>
      <TooltipContent>{meta.label}</TooltipContent>
    </Tooltip>
  );
}

export function IssueKey({ issue }: { issue: Issue }) {
  return (
    <span
      className={cn(
        "shrink-0 text-xs font-medium text-muted-foreground",
        issue.done && "line-through",
      )}
    >
      {issue.key}
    </span>
  );
}

export function IssuePriority({ priority }: { priority: Priority }) {
  const meta = priorityMeta[priority];
  return (
    <Tooltip>
      <TooltipTrigger render={<span />} className={cn("shrink-0", meta.className)}>
        <HugeiconsIcon icon={meta.icon} strokeWidth={2.5} className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{meta.label} priority</TooltipContent>
    </Tooltip>
  );
}

export function IssueAssignee({ assignee }: { assignee: Issue["assignee"] }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold",
          assignee
            ? "bg-primary text-primary-foreground"
            : "border border-dashed border-muted-foreground/50 text-muted-foreground",
        )}
      >
        {assignee ? initials(assignee.name) : "?"}
      </TooltipTrigger>
      <TooltipContent>{assignee?.name ?? "Unassigned"}</TooltipContent>
    </Tooltip>
  );
}

export function IssueLabel({ label }: { label: string }) {
  return (
    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground uppercase">
      {label}
    </span>
  );
}

export function IssueDueDate({ issue }: { issue: Issue }) {
  if (!issue.dueDate) return null;
  const overdue = !issue.done && isOverdue(issue.dueDate);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
        overdue ? "bg-destructive/10 text-destructive" : "text-muted-foreground",
      )}
    >
      <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-3" />
      {dueFormat.format(new Date(`${issue.dueDate}T00:00:00`))}
    </span>
  );
}

export function IssueComments({ count }: { count?: number }) {
  if (!count) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
      <HugeiconsIcon icon={Message01Icon} strokeWidth={2} className="size-3.5" />
      {count}
    </span>
  );
}

/** Higher number = more urgent; for sorting. */
export const priorityRank: Record<Priority, number> = {
  highest: 4,
  high: 3,
  medium: 2,
  low: 1,
  P0: 4,
  P1: 3,
  P2: 2,
  P3: 1,
  P4: 0,
};

export function issueTypeLabel(type: IssueType) {
  return typeMeta[type as keyof typeof typeMeta]?.label ?? type;
}

/** PR status icon (number only in the tooltip), linking to the PR on its provider. */
export function IssuePullRequestStatus({ pullRequest }: { pullRequest?: IssuePullRequest }) {
  if (!pullRequest) return null;
  const status = pullRequestStatus(pullRequest);
  const meta = pullRequestMeta[status];
  const provider = providerMeta[pullRequest.provider];
  const label = pullRequestLabels[pullRequest.provider][status];
  const number = `${provider.prefix}${pullRequest.number}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<a href={pullRequest.url} target="_blank" rel="noreferrer" />}
        aria-label={`Pull request ${number}: ${label}`}
        onClick={(event) => event.stopPropagation()}
        className={cn(
          "inline-flex shrink-0 items-center rounded-sm hover:opacity-80",
          meta.className,
        )}
      >
        <HugeiconsIcon icon={meta.icon} strokeWidth={2} className="size-4" />
      </TooltipTrigger>
      <TooltipContent>
        {label} · {provider.name} pull request {number}
      </TooltipContent>
    </Tooltip>
  );
}
