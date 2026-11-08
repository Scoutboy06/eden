import { cn } from "cn";
import type * as React from "react";

import {
  type Issue,
  IssueAssignee,
  IssueComments,
  IssueDueDate,
  IssueKey,
  IssueLabel,
  IssuePriority,
  IssuePullRequestStatus,
  IssueTypeIcon,
} from "@/components/issue/issue";
import { Card } from "@/components/ui/card";

/** A single issue on the kanban board, laid out like a Jira card. */
export function KanbanCard({
  item,
  className,
  ...props
}: React.ComponentProps<typeof Card> & { item: Issue }) {
  return (
    <Card
      size="sm"
      className={cn(
        "cursor-pointer gap-3 bg-sidebar shadow-xs ring-foreground/20 hover:outline-1 hover:outline-dashed hover:outline-muted-foreground hover:outline-offset-2",
        className,
      )}
      {...props}
    >
      <p className="px-3 leading-snug">{item.title}</p>

      {(item.labels?.length || item.dueDate) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3">
          {item.labels?.map((label) => (
            <IssueLabel key={label} label={label} />
          ))}
          <IssueDueDate issue={item} />
        </div>
      )}

      <footer className="flex items-center gap-2 px-3">
        <IssueTypeIcon type={item.type} />
        <IssueKey issue={item} />
        <div className="ml-auto flex items-center gap-2">
          <IssuePullRequestStatus pullRequest={item.pullRequest} />
          <IssueComments count={item.commentCount} />
          <IssuePriority priority={item.priority} />
          <IssueAssignee assignee={item.assignee} />
        </div>
      </footer>
    </Card>
  );
}
