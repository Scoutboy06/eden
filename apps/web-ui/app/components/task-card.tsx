import { useState } from "react";

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
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentHovered, setAgentHovered] = useState(false);
  const disabled = task.worktree === null;
  const taskHoverClassName =
    !disabled && !selected && !agentHovered ? "hover:bg-muted/50 dark:hover:bg-background/50" : "";
  const runningAgentCount = task.runningAgents.length;
  const agentNoun = runningAgentCount === 1 ? "agent" : "agents";
  const runningAgentNames = task.runningAgents
    .map((agent) => agentHarnesses[agent.harness].title)
    .join(", ");
  const agentsLabel =
    runningAgentCount > 0
      ? `${runningAgentCount} running ${agentNoun}: ${runningAgentNames}`
      : "No running agents";
  const pullRequestLabel = task.pullRequest
    ? formatPullRequestReference(task.pullRequest.provider, task.pullRequest.number)
    : null;
  let stateClassName = "border-transparent";
  if (!disabled && selected) {
    stateClassName = "border-solid border-muted-foreground/40 bg-sidebar-accent/40";
  }

  return (
    <div
      className={`group flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${disabled ? "opacity-45" : ""} ${taskHoverClassName} ${stateClassName}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      >
        <circle cx="4" cy="3" r="1.75" />
        <circle cx="12" cy="4" r="1.75" />
        <circle cx="4" cy="13" r="1.75" />
        <path d="M4 4.75v6.5m8-5.5v.5a3 3 0 0 1-3 3H7a3 3 0 0 0-3 3" />
      </svg>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={selected}
          onClick={onSelect}
          className="block w-full cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed"
        >
          <span className="block truncate text-sm font-medium text-foreground">{task.title}</span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate font-mono">{task.key}</span>
            {pullRequestLabel ? (
              <span className="shrink-0 font-mono">{pullRequestLabel}</span>
            ) : null}
            {task.ci ? <CIStatus status={task.ci} size="size-2" /> : null}
          </span>
        </button>
        {task.runningAgents.length > 0 ? (
          <span
            aria-label={agentsLabel}
            title={agentsLabel}
            className="mt-2 flex min-w-0 flex-col gap-1 text-xs text-muted-foreground"
          >
            <span className="sr-only">Running agents:</span>
            {task.runningAgents.map((agent) => (
              <button
                key={agent.id}
                onPointerEnter={() => setAgentHovered(true)}
                onPointerLeave={() => setAgentHovered(false)}
                type="button"
                disabled={disabled}
                aria-pressed={selected && selectedAgentId === agent.id}
                onClick={() => {
                  setSelectedAgentId(agent.id);
                  onSelect();
                }}
                title={`Running · ${agentHarnesses[agent.harness].title} · ${agent.title}`}
                className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-0.5 py-1.5 text-left outline-none transition-colors duration-150 enabled:hover:bg-sidebar-accent/40 enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-pressed:text-foreground disabled:cursor-not-allowed motion-reduce:transition-none"
              >
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
                <HarnessIcon harness={agent.harness} />
                <span className="shrink-0">{agentHarnesses[agent.harness].title}</span>
                <span aria-hidden="true" className="text-muted-foreground/50">
                  |
                </span>
                <span className="truncate">{agent.title}</span>
              </button>
            ))}
          </span>
        ) : null}
      </div>
    </div>
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
