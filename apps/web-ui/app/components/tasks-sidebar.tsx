import { useMemo, useState } from "react";

import { TaskCard } from "@/components/task-card";
import { agentHarnesses, tasks } from "@/components/tasks-sidebar-data";
import { formatPullRequestReference } from "@/pages/prs-data";

export function TasksSidebar({ open }: { open: boolean }) {
  const [query, setQuery] = useState("");
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(null);
  const [inactiveExpanded, setInactiveExpanded] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTasks = useMemo(
    () =>
      tasks.filter((task) =>
        [
          task.key,
          task.title,
          task.worktree?.name,
          task.worktree?.branch,
          task.pullRequest &&
            formatPullRequestReference(task.pullRequest.provider, task.pullRequest.number),
          ...task.runningAgents.flatMap((agent) => [
            agentHarnesses[agent.harness].title,
            agent.title,
          ]),
        ]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalizedQuery)),
      ),
    [normalizedQuery],
  );
  const activeTasks = filteredTasks.filter((task) => task.worktree !== null);
  const inactiveTasks = filteredTasks.filter((task) => task.worktree === null);
  const inactiveContentExpanded =
    inactiveExpanded || (normalizedQuery.length > 0 && inactiveTasks.length > 0);

  return (
    <aside
      id="tasks-sidebar"
      aria-label="Tasks"
      aria-hidden={!open}
      className={`${open ? "flex" : "hidden"} h-svh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground sm:w-72 lg:w-80`}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border px-3">
        <h2 className="text-sm font-semibold">Tasks</h2>
        <span className="font-mono text-xs text-muted-foreground">{tasks.length}</span>
      </div>
      <label className="mx-3 my-3 flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-muted-foreground focus-within:ring-2 focus-within:ring-ring/50">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0" fill="none">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <input
          aria-label="Filter tasks"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter tasks…"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => setQuery("")}
            className="rounded px-1 text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            ×
          </button>
        ) : null}
      </label>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-3">
        {activeTasks.map((task) => (
          <TaskCard
            key={task.key}
            task={task}
            selected={selectedTaskKey === task.key}
            onSelect={() => setSelectedTaskKey(task.key)}
          />
        ))}
        {inactiveTasks.length > 0 ? (
          <section className="pt-2">
            <button
              type="button"
              aria-expanded={inactiveContentExpanded}
              aria-controls="inactive-tasks"
              onClick={() => setInactiveExpanded(!inactiveExpanded)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className={`size-3 shrink-0 transition-transform ${inactiveContentExpanded ? "rotate-90" : ""}`}
                fill="none"
              >
                <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <span className="flex-1">Inactive</span>
              <span className="font-mono">{inactiveTasks.length}</span>
            </button>
            <div id="inactive-tasks" hidden={!inactiveContentExpanded} className="space-y-1.5">
              {inactiveTasks.map((task) => (
                <TaskCard
                  key={task.key}
                  task={task}
                  selected={selectedTaskKey === task.key}
                  onSelect={() => setSelectedTaskKey(task.key)}
                />
              ))}
            </div>
          </section>
        ) : null}
        {filteredTasks.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">No matching tasks</p>
        ) : null}
      </div>
    </aside>
  );
}
