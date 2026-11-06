import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import { useState } from "react";
import type * as React from "react";

import {
  type Issue,
  IssueAssignee,
  IssueComments,
  IssueDueDate,
  type IssueGroup,
  IssueKey,
  IssueLabel,
  IssuePriority,
  IssueTypeIcon,
} from "@/components/issue/issue";

/** Issues as compact rows, grouped by status, with collapsible groups. */
export function IssueList({
  groups,
  className,
  ...props
}: React.ComponentProps<"div"> & { groups: IssueGroup[] }) {
  return (
    <div className={cn("flex flex-col gap-4", className)} {...props}>
      {groups.map((group) => (
        <IssueListGroup key={group.id} group={group} />
      ))}
    </div>
  );
}

function IssueListGroup({ group }: { group: IssueGroup }) {
  const [open, setOpen] = useState(true);
  const contentId = `issue-list-${group.id}`;

  return (
    <section aria-label={group.title}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-md px-1 py-1 text-sm font-medium hover:bg-accent/50"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        {group.title}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">
          {group.items.length}
        </span>
      </button>
      {open && (
        <ul
          id={contentId}
          className="mt-1 divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10"
        >
          {group.items.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-muted-foreground">No issues</li>
          ) : (
            group.items.map((issue) => <IssueListRow key={issue.id} issue={issue} />)
          )}
        </ul>
      )}
    </section>
  );
}

function IssueListRow({ issue }: { issue: Issue }) {
  return (
    <li className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-accent/50">
      <IssueTypeIcon type={issue.type} />
      <span className="w-16">
        <IssueKey issue={issue} />
      </span>
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      <div className="hidden items-center gap-1.5 sm:flex">
        {issue.labels?.map((label) => (
          <IssueLabel key={label} label={label} />
        ))}
        <IssueDueDate issue={issue} />
      </div>
      <IssueComments count={issue.commentCount} />
      <IssuePriority priority={issue.priority} />
      <IssueAssignee assignee={issue.assignee} />
    </li>
  );
}
