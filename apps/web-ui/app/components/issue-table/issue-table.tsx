import { ArrowDown01Icon, ArrowUp01Icon, ArrowUpDownIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import { useMemo, useState } from "react";
import type * as React from "react";
import { TaskTitle, TaskOpeningContext } from "@/components/issue/task-opening";
import { useContext } from "react";

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
  issueTypeLabel,
  priorityRank,
  pullRequestStatus,
  pullRequestStatusRank,
} from "@/components/issue/issue";

type Row = { issue: Issue; status: IssueGroup; statusIndex: number };

type SortKey =
  | "type"
  | "key"
  | "title"
  | "status"
  | "priority"
  | "pullRequest"
  | "assignee"
  | "dueDate";
type Sort = { key: SortKey; direction: "asc" | "desc" } | null;

/** Sort value per column. `undefined` always sorts last, whatever the direction. */
const sortValue: Record<SortKey, (row: Row) => string | number | undefined> = {
  type: (row) => issueTypeLabel(row.issue.type),
  // Numeric part of the key, so EDEN-9 sorts before EDEN-10.
  key: (row) => Number(row.issue.key.split("-").at(-1)) || row.issue.key,
  title: (row) => row.issue.title.toLowerCase(),
  status: (row) => row.statusIndex,
  priority: (row) => priorityRank[row.issue.priority],
  pullRequest: (row) =>
    row.issue.pullRequest && pullRequestStatusRank[pullRequestStatus(row.issue.pullRequest)],
  assignee: (row) => row.issue.assignee?.name.toLowerCase(),
  dueDate: (row) => row.issue.dueDate,
};

function compareRows(a: Row, b: Row, sort: NonNullable<Sort>) {
  const x = sortValue[sort.key](a);
  const y = sortValue[sort.key](b);
  if (x === y) return 0;
  if (x === undefined) return 1;
  if (y === undefined) return -1;
  const result = x < y ? -1 : 1;
  return sort.direction === "asc" ? result : -result;
}

const columns: { key: SortKey | null; label: string; className?: string }[] = [
  { key: "type", label: "Type", className: "w-12" },
  { key: "key", label: "Key", className: "w-24" },
  { key: "title", label: "Summary" },
  { key: "status", label: "Status", className: "w-32" },
  { key: "priority", label: "Priority", className: "w-20" },
  { key: "pullRequest", label: "PR", className: "w-16" },
  { key: "assignee", label: "Assignee", className: "w-40" },
  { key: null, label: "Labels", className: "w-36" },
  { key: "dueDate", label: "Due", className: "w-24" },
  { key: null, label: "Comments", className: "w-24" },
];

/** Every issue as one table row, with sortable columns. */
export function IssueTable({
  groups,
  className,
  ...props
}: React.ComponentProps<"div"> & { groups: IssueGroup[] }) {
  const openTask = useContext(TaskOpeningContext);
  const [sort, setSort] = useState<Sort>(null);

  const rows = useMemo(() => {
    const all = groups.flatMap((status, statusIndex) =>
      status.items.map((issue) => ({ issue, status, statusIndex })),
    );
    // Unsorted keeps board order (status, then position in column).
    return sort ? all.toSorted((a, b) => compareRows(a, b, sort)) : all;
  }, [groups, sort]);

  // Click cycles ascending → descending → unsorted.
  function toggleSort(key: SortKey) {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: "asc" };
      return current.direction === "asc" ? { key, direction: "desc" } : null;
    });
  }

  return (
    <div
      className={cn("overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10", className)}
      {...props}
    >
      <table className="w-full min-w-[58rem] text-sm">
        <thead className="border-b border-border text-xs text-muted-foreground">
          <tr>
            {columns.map((column) => {
              const active = column.key !== null && sort?.key === column.key;
              let sortOrder: "ascending" | "descending" | undefined;
              let sortIcon = ArrowUpDownIcon;

              if (active && sort) {
                sortOrder = sort.direction === "asc" ? "ascending" : "descending";
                sortIcon = sort.direction === "asc" ? ArrowUp01Icon : ArrowDown01Icon;
              }

              return (
                <th
                  key={column.label}
                  scope="col"
                  aria-sort={sortOrder}
                  className={cn("px-3 py-2 text-left font-medium", column.className)}
                >
                  {column.key === null ? (
                    column.label
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key!)}
                      className={cn(
                        "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-accent/50 hover:text-foreground",
                        active && "text-foreground",
                      )}
                    >
                      {column.label}
                      <HugeiconsIcon
                        icon={sortIcon}
                        strokeWidth={2}
                        className={cn("size-3.5", !active && "opacity-50")}
                      />
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(({ issue, status }) => (
            <tr
              key={issue.id}
              onClick={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest("button, a")) return;

                const row = event.currentTarget;
                const trigger = row.querySelector<HTMLElement>("[data-task-open]") ?? row;
                openTask?.(issue.id, trigger);
              }}
              className="cursor-pointer hover:outline-1 hover:outline-dashed hover:outline-muted-foreground hover:outline-offset-[-2px]"
            >
              <td className="px-3 py-2">
                <IssueTypeIcon type={issue.type} />
              </td>
              <td className="px-3 py-2">
                <IssueKey issue={issue} />
              </td>
              <td className="max-w-0 truncate px-3 py-2">
                <TaskTitle id={issue.id}>{issue.title}</TaskTitle>
              </td>
              <td className="px-3 py-2">
                <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-secondary-foreground uppercase">
                  {status.title}
                </span>
              </td>
              <td className="px-3 py-2">
                <IssuePriority priority={issue.priority} />
              </td>
              <td className="px-3 py-2">
                <IssuePullRequestStatus pullRequest={issue.pullRequest} />
              </td>
              <td className="px-3 py-2">
                <span className="flex items-center gap-2">
                  <IssueAssignee assignee={issue.assignee} />
                  <span className={cn("truncate", !issue.assignee && "text-muted-foreground")}>
                    {issue.assignee?.name ?? "Unassigned"}
                  </span>
                </span>
              </td>
              <td className="px-3 py-2">
                <span className="flex flex-wrap gap-1">
                  {issue.labels?.map((label) => (
                    <IssueLabel key={label} label={label} />
                  ))}
                </span>
              </td>
              <td className="px-3 py-2">
                <IssueDueDate issue={issue} />
              </td>
              <td className="px-3 py-2">
                <IssueComments count={issue.commentCount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
