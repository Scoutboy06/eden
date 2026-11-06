import { CIStatus } from "@/components/ci-status";
import { agentHarnesses, type AgentHarness, type Task } from "@/components/tasks-sidebar-data";
import { formatPullRequestReference } from "@/pages/prs-data";

export function TaskCard({
  task,
  selected,
  onSelect,
}: {
  task: Task;
  selected: boolean;
  onSelect: () => void;
}) {
  const disabled = task.worktree === null;
  const agentsLabel = task.runningAgents.length
    ? `${task.runningAgents.length} running ${task.runningAgents.length === 1 ? "agent" : "agents"}: ${task.runningAgents.map((agent) => agentHarnesses[agent.harness].title).join(", ")}`
    : "No running agents";
  const pullRequestLabel = task.pullRequest
    ? formatPullRequestReference(task.pullRequest.provider, task.pullRequest.number)
    : null;
  const stateClassName = disabled
    ? "border-transparent"
    : selected
      ? "border-solid border-muted-foreground/40 bg-sidebar-accent/40"
      : "border-transparent hover:border-dashed hover:border-muted-foreground/50";

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
      className={`group w-full rounded-md border px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45 ${stateClassName}`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {task.title}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {task.reviewCount ? (
            <span
              aria-label={`${task.reviewCount} unresolved review comments`}
              title={`${task.reviewCount} unresolved review comments`}
              className="rounded bg-attention/10 px-1 py-0.5 text-xs leading-none text-attention"
            >
              {task.reviewCount} ↩
            </span>
          ) : null}
        </span>
      </span>
      <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
        {task.key}
      </span>
      <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className="min-w-0 flex-1 truncate"
          title={task.worktree?.branch ?? task.worktree?.name ?? "No worktree"}
        >
          {task.worktree
            ? task.worktree.branch
              ? `⑂ ${task.worktree.branch}`
              : `⑂ ${task.worktree.name}`
            : "No worktree"}
        </span>
        {pullRequestLabel ? <span className="shrink-0 font-mono">{pullRequestLabel}</span> : null}
        {task.ci ? <CIStatus status={task.ci} size="size-2" /> : null}
      </span>
      {task.runningAgents.length > 0 ? (
        <span
          aria-label={agentsLabel}
          title={agentsLabel}
          className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
        >
          <span className="sr-only">Running agents:</span>
          {task.runningAgents.map((agent) => (
            <span key={agent.id} className="inline-flex items-center gap-1">
              <HarnessIcon harness={agent.harness} />
              <span>{agentHarnesses[agent.harness].title}</span>
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

function HarnessIcon({ harness }: { harness: AgentHarness }) {
  if (harness === "claude-code") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 shrink-0" fill="currentColor">
        <path d="M8 1.25 9.4 5l3.7-1.4-1.4 3.7 3.7 1.4-3.7 1.4 1.4 3.7-3.7-1.4L8 16l-1.4-3.6-3.7 1.4 1.4-3.7L.6 8.7l3.7-1.4-1.4-3.7 3.7 1.4L8 1.25Z" />
      </svg>
    );
  }

  if (harness === "codex") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 shrink-0" fill="none">
        <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path d="m6 6 2 2-2 2m4 0h1" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 shrink-0" fill="none">
      <path
        d="M5.5 3 1.75 8l3.75 5m5-10 3.75 5-3.75 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
