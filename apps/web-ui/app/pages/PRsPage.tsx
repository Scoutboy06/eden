import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  deriveReviewRows,
  formatPullRequestReference,
  getQueuePositions,
  pullRequestQueues,
  pullRequestTasks,
  stackRelations,
  type QueuePosition,
  type ReviewRow,
} from "@/pages/prs-data";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const voteLabels = {
  approved: "Approved",
  suggestions: "Approved with suggestions",
  waiting: "Waiting for author",
  rejected: "Rejected",
  none: "No vote yet",
} as const;

export function PRsPage() {
  const rows: ReviewRow[] = deriveReviewRows(pullRequestTasks, stackRelations);
  const queuePositions: Map<string, QueuePosition> = getQueuePositions(pullRequestQueues);

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3" aria-label="In review">
      <div className="rounded-xl border border-border bg-card">
        <Table className="min-w-[920px] border-collapse text-left text-sm">
          <TableCaption className="sr-only">Pull requests in review</TableCaption>
          <TableHeader className="bg-muted/50 text-xs text-muted-foreground">
            <TableRow>
              <TableHead scope="col" className="px-3 py-2.5 font-medium">
                Ticket · worktree
              </TableHead>
              <TableHead scope="col" className="px-3 py-2.5 font-medium">
                PR
              </TableHead>
              <TableHead scope="col" className="px-3 py-2.5 font-medium">
                CI
              </TableHead>
              <TableHead scope="col" className="px-3 py-2.5 font-medium">
                Vote
              </TableHead>
              <TableHead scope="col" className="px-3 py-2.5 font-medium">
                Comments
              </TableHead>
              <TableHead scope="col" className="px-3 py-2.5 font-medium">
                Target
              </TableHead>
              <TableHead scope="col" className="px-3 py-2.5 font-medium">
                Queue
              </TableHead>
              <TableHead scope="col" className="w-24 px-3 py-2.5">
                <span className="sr-only">Action</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <PRRow key={row.task.id} row={row} queue={queuePositions.get(row.task.id)} />
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {(Object.keys(voteLabels) as (keyof typeof voteLabels)[]).map((vote) => (
          <VoteStatus key={vote} vote={vote} showLabel />
        ))}
      </div>
    </section>
  );
}

function PRRow({
  row: { task, parent },
  queue,
}: {
  row: ReviewRow;
  queue: QueuePosition | undefined;
}) {
  const reference = formatPullRequestReference(task.provider, task.pullRequest);

  return (
    <TableRow className={parent ? "group bg-muted/60 hover:bg-muted/80" : "group"}>
      <TableHead scope="row" className="px-3 py-3 font-normal">
        <div className="flex min-w-56 items-start gap-2">
          {parent ? (
            <span aria-hidden="true" className="mt-0.5 font-mono text-muted-foreground">
              └
            </span>
          ) : null}
          <span className="min-w-0">
            <span className="block font-mono text-xs font-semibold text-foreground">{task.id}</span>
            <span className="block truncate text-xs text-muted-foreground">{task.worktree}</span>
          </span>
        </div>
      </TableHead>
      <TableCell className="px-3 py-3 font-mono text-xs">
        {reference === null ? (
          <span className="text-muted-foreground">after parent merges</span>
        ) : task.pullRequestUrl ? (
          <a
            href={task.pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${task.provider === "github" ? "GitHub" : "Azure DevOps"} pull request ${reference} in a new tab`}
            className="rounded-sm text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {reference}
          </a>
        ) : (
          <span>{reference}</span>
        )}
      </TableCell>
      <TableCell className="px-3 py-3">
        {task.ci ? <CIStatus status={task.ci} /> : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="px-3 py-3">
        <VoteStatus vote={task.vote} />
      </TableCell>
      <TableCell className="px-3 py-3">
        <CommentsStatus comments={task.comments} />
      </TableCell>
      <TableCell className="px-3 py-3 font-mono text-xs">
        {parent ? (
          <span
            title={`Stacked on ${parent.branch}`}
            aria-label={`Stacked on ${parent.id}, branch ${parent.branch}`}
            className="inline-block max-w-48 truncate align-bottom text-muted-foreground"
          >
            ↳ {parent.branch}
          </span>
        ) : (
          <span>
            <span>{task.target}</span>
            <span className="ml-2 text-muted-foreground">
              ↑{task.ahead} ↓{task.behind}
            </span>
          </span>
        )}
      </TableCell>
      <TableCell className="px-3 py-3">
        {queue ? (
          <span className="rounded-md border border-border bg-muted px-1.5 py-1 text-xs">
            {queue.name} #{queue.position}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="w-24 px-3 py-2 text-right">
        <RowActions task={task} />
      </TableCell>
    </TableRow>
  );
}

function CommentsStatus({ comments }: { comments: ReviewRow["task"]["comments"] }) {
  return (
    <div className="flex min-w-36 flex-wrap items-center gap-1.5">
      {comments.new > 0 ? (
        <span className="rounded-md bg-attention/10 px-1.5 py-0.5 text-xs text-attention">
          {comments.new} new
        </span>
      ) : null}
      {comments.fixing ? (
        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-xs text-primary">fixing</span>
      ) : null}
      {comments.handled > 0 ? (
        <span className="text-xs text-muted-foreground">{comments.handled} handled</span>
      ) : null}
      {comments.new === 0 && !comments.fixing && comments.handled === 0 ? (
        <span className="text-xs text-muted-foreground">—</span>
      ) : null}
    </div>
  );
}

function RowActions({ task }: { task: ReviewRow["task"] }) {
  const [feedback, setFeedback] = useState<"copied branch" | "copied task key" | "error" | null>(
    null,
  );

  async function copy(value: string, label: "branch" | "task key") {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(label === "branch" ? "copied branch" : "copied task key");
    } catch {
      setFeedback("error");
    }
  }

  return (
    <div className="flex min-h-8 items-center justify-end gap-1">
      {feedback === "error" ? (
        <span className="max-w-32 text-left text-[10px] text-destructive">Copy failed</span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Actions for ${task.id}`}
          className="pr-row-actions-trigger inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-opacity hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="currentColor">
            <circle cx="3" cy="8" r="1.25" />
            <circle cx="8" cy="8" r="1.25" />
            <circle cx="13" cy="8" r="1.25" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom">
          <DropdownMenuItem disabled>Rebase</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void copy(task.branch, "branch")}>
            Copy branch name
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copy(task.id, "task key")}>
            Copy task key
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {feedback === "copied branch"
          ? "Branch name copied"
          : feedback === "copied task key"
            ? "Task key copied"
            : feedback === "error"
              ? "Copy failed"
              : ""}
      </span>
    </div>
  );
}

function CIStatus({ status }: { status: "passing" | "pending" | "failing" }) {
  const details = {
    passing: { label: "Passing", className: "bg-success" },
    pending: { label: "Pending", className: "bg-attention" },
    failing: { label: "Failing", className: "bg-destructive" },
  }[status];

  return (
    <Tooltip>
      <TooltipTrigger render={<span />} className="inline-flex items-center">
        <span aria-hidden="true" className={`size-2 rounded-full ${details.className}`} />
        <span className="sr-only">{details.label}</span>
      </TooltipTrigger>
      <TooltipContent>{details.label}</TooltipContent>
    </Tooltip>
  );
}

function VoteStatus({
  vote,
  showLabel = false,
}: {
  vote: keyof typeof voteLabels;
  showLabel?: boolean;
}) {
  const color =
    vote === "approved" || vote === "suggestions"
      ? "text-success"
      : vote === "waiting"
        ? "text-attention"
        : vote === "rejected"
          ? "text-destructive"
          : "text-muted-foreground";

  const icon = (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={`size-[18px] shrink-0 ${color}`}>
      {vote === "none" ? (
        <circle
          cx="8"
          cy="8"
          r="7"
          fill="transparent"
          stroke="currentColor"
          strokeDasharray="2 2"
        />
      ) : (
        <circle cx="8" cy="8" r="7" fill="currentColor" />
      )}
      {vote === "approved" ? (
        <path
          d="M5 8.5l2 2 4-4.5"
          className="stroke-success-foreground"
          strokeWidth="1.8"
          fill="none"
        />
      ) : null}
      {vote === "suggestions" ? (
        <>
          <path
            d="M4.5 8.5l2 2 3.5-4"
            className="stroke-success-foreground"
            strokeWidth="1.6"
            fill="none"
          />
          <circle cx="12" cy="4" r="2.2" className="fill-attention" />
        </>
      ) : null}
      {vote === "waiting" ? (
        <path
          d="M8 4.5V8l2.2 1.6"
          className="stroke-attention-foreground"
          strokeWidth="1.6"
          fill="none"
        />
      ) : null}
      {vote === "rejected" ? (
        <path
          d="M5.5 5.5l5 5M10.5 5.5l-5 5"
          className="stroke-destructive-foreground"
          strokeWidth="1.8"
        />
      ) : null}
    </svg>
  );

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {showLabel ? (
        <>
          {icon}
          <span>{voteLabels[vote]}</span>
        </>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span />} className="inline-flex">
            {icon}
            <span className="sr-only">{voteLabels[vote]}</span>
          </TooltipTrigger>
          <TooltipContent>{voteLabels[vote]}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
