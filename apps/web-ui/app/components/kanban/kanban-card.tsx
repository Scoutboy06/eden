import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpDoubleIcon,
  Bookmark02Icon,
  Bug01Icon,
  Calendar03Icon,
  CheckmarkSquare02Icon,
  EqualSignIcon,
  Message01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import type * as React from "react";

import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type IssueType = "story" | "bug" | "task";
export type Priority = "highest" | "high" | "medium" | "low";

export type KanbanItem = {
  id: string;
  /** Human-readable key, e.g. "EDEN-42". */
  key: string;
  title: string;
  type: IssueType;
  priority: Priority;
  labels?: string[];
  assignee?: { name: string };
  /** ISO date (yyyy-mm-dd). */
  dueDate?: string;
  commentCount?: number;
  done?: boolean;
};

const typeMeta = {
  story: { label: "Story", icon: Bookmark02Icon, className: "bg-chart-2/15 text-chart-2" },
  bug: { label: "Bug", icon: Bug01Icon, className: "bg-destructive/15 text-destructive" },
  task: { label: "Task", icon: CheckmarkSquare02Icon, className: "bg-primary/15 text-primary" },
} satisfies Record<IssueType, { label: string; icon: unknown; className: string }>;

const priorityMeta = {
  highest: {
    label: "Highest",
    icon: ArrowUpDoubleIcon,
    className: "text-destructive",
  },
  high: { label: "High", icon: ArrowUp01Icon, className: "text-attention" },
  medium: { label: "Medium", icon: EqualSignIcon, className: "text-muted-foreground" },
  low: { label: "Low", icon: ArrowDown01Icon, className: "text-muted-foreground/70" },
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

/** A single issue on the kanban board, laid out like a Jira card. */
export function KanbanCard({
  item,
  className,
  ...props
}: React.ComponentProps<typeof Card> & { item: KanbanItem }) {
  const type = typeMeta[item.type];
  const priority = priorityMeta[item.priority];
  const overdue = !item.done && item.dueDate && isOverdue(item.dueDate);

  return (
    <Card
      size="sm"
      className={cn(
        "cursor-pointer gap-3 shadow-xs transition-colors hover:bg-accent/50",
        className,
      )}
      {...props}
    >
      <p className="px-3 leading-snug">{item.title}</p>

      {(item.labels?.length || item.dueDate) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3">
          {item.labels?.map((label) => (
            <span
              key={label}
              className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground uppercase"
            >
              {label}
            </span>
          ))}
          {item.dueDate && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
                overdue ? "bg-destructive/10 text-destructive" : "text-muted-foreground",
              )}
            >
              <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-3" />
              {dueFormat.format(new Date(`${item.dueDate}T00:00:00`))}
            </span>
          )}
        </div>
      )}

      <footer className="flex items-center gap-2 px-3">
        <Tooltip>
          <TooltipTrigger
            render={<span />}
            className={cn("grid size-4 place-items-center rounded-sm", type.className)}
          >
            <HugeiconsIcon icon={type.icon} strokeWidth={2.5} className="size-3" />
          </TooltipTrigger>
          <TooltipContent>{type.label}</TooltipContent>
        </Tooltip>
        <span
          className={cn("text-xs font-medium text-muted-foreground", item.done && "line-through")}
        >
          {item.key}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {!!item.commentCount && (
            <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
              <HugeiconsIcon icon={Message01Icon} strokeWidth={2} className="size-3.5" />
              {item.commentCount}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger render={<span />} className={priority.className}>
              <HugeiconsIcon icon={priority.icon} strokeWidth={2.5} className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{priority.label} priority</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={<span />}
              className={cn(
                "grid size-6 place-items-center rounded-full text-[10px] font-semibold",
                item.assignee
                  ? "bg-primary text-primary-foreground"
                  : "border border-dashed border-muted-foreground/50 text-muted-foreground",
              )}
            >
              {item.assignee ? initials(item.assignee.name) : "?"}
            </TooltipTrigger>
            <TooltipContent>{item.assignee?.name ?? "Unassigned"}</TooltipContent>
          </Tooltip>
        </div>
      </footer>
    </Card>
  );
}
