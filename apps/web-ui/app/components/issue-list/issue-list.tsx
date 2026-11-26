import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import { useState } from "react";
import type * as React from "react";
import { TaskTitle, useTaskClick } from "@/components/issue/task-opening";
import { useVirtualList } from "@/components/virtual-list/use-virtual-list";

import {
  type Issue,
  IssueAssignee,
  IssueComments,
  IssueDueDate,
  type IssueGroup,
  IssueKey,
  IssueLabel,
  IssuePriority,
  IssuePullRequestStatus,
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
  const { scrollElement, virtualizer } = useVirtualList({
    items: group.items,
    estimateSize: 42,
  });

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
        <div
          ref={scrollElement}
          className="mt-1 max-h-[min(70vh,40rem)] overflow-y-auto overscroll-y-contain rounded-xl bg-card ring-1 ring-foreground/10"
        >
          <ul
            id={contentId}
            aria-label={`${group.title} issues`}
            className="divide-y divide-border"
            style={{
              height: group.items.length === 0 ? undefined : virtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {group.items.length === 0 ? (
              <li className="px-3 py-2.5 text-sm text-muted-foreground">No issues</li>
            ) : (
              virtualizer.getVirtualItems().map((virtualItem) => {
                const issue = group.items[virtualItem.index]!;
                return (
                  <IssueListRow
                    key={issue.id}
                    issue={issue}
                    index={virtualItem.index}
                    start={virtualItem.start}
                    size={group.items.length}
                    measureRef={virtualizer.measureElement}
                  />
                );
              })
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

function IssueListRow({
  issue,
  index,
  start,
  size,
  measureRef,
}: {
  issue: Issue;
  index: number;
  start: number;
  size: number;
  measureRef: (element: Element | null) => void;
}) {
  const openTask = useTaskClick(issue.id);
  return (
    <li
      ref={measureRef}
      data-index={index}
      aria-posinset={index + 1}
      aria-setsize={size}
      onClick={openTask}
      className="absolute top-0 flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:outline-1 hover:outline-dashed hover:outline-muted-foreground hover:outline-offset-[-2px]"
      style={{ transform: `translateY(${start}px)` }}
    >
      <IssueTypeIcon type={issue.type} />
      <span className="w-16">
        <IssueKey issue={issue} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <TaskTitle id={issue.id}>{issue.title}</TaskTitle>
      </span>
      <div className="hidden items-center gap-1.5 sm:flex">
        {issue.labels?.map((label) => (
          <IssueLabel key={label} label={label} />
        ))}
        <IssueDueDate issue={issue} />
      </div>
      <IssuePullRequestStatus pullRequest={issue.pullRequest} />
      <IssueComments count={issue.commentCount} />
      <IssuePriority priority={issue.priority} />
      <IssueAssignee assignee={issue.assignee} />
    </li>
  );
}
