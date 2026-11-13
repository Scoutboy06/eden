import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { TaskCard } from "@/components/task-card";
import { agentHarnesses, tasks } from "@/components/tasks-sidebar-data";
import { useWorktrees } from "@/pages/use-worktrees";
import { formatPullRequestReference } from "@/pages/prs-data";
import type { WorktreeProjection } from "@/pages/worktrees";

export function TasksSidebar({
  open,
  selectedTaskKey,
  onSelectTask,
}: {
  open: boolean;
  selectedTaskKey: string;
  onSelectTask: (key: string) => void;
}) {
  const { project = "" } = useParams();
  const [query, setQuery] = useState("");
  const [inactiveExpanded, setInactiveExpanded] = useState(false);
  const worktreeData = useWorktrees(project);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTasks = useMemo(
    () => tasks.filter((task) => matchesTask(task, normalizedQuery)),
    [normalizedQuery],
  );
  const activeTasks = filteredTasks.filter((task) => task.worktree !== null);
  const inactiveTasks = filteredTasks.filter((task) => task.worktree === null);
  const inactiveContentExpanded =
    inactiveExpanded || (normalizedQuery.length > 0 && inactiveTasks.length > 0);
  const filteredWorktrees = worktreeData.worktrees.filter((worktree) =>
    matchesWorktree(worktree, normalizedQuery),
  );

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
      <TaskSearch query={query} onChange={setQuery} />
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-3">
        <WorktreesSection
          data={worktreeData}
          worktrees={filteredWorktrees}
          query={normalizedQuery}
        />
        <TasksSection
          activeTasks={activeTasks}
          inactiveTasks={inactiveTasks}
          selectedTaskKey={selectedTaskKey}
          onSelectTask={onSelectTask}
          inactiveExpanded={inactiveContentExpanded}
          onToggleInactive={() => setInactiveExpanded(!inactiveExpanded)}
          hasMatches={filteredTasks.length > 0 || filteredWorktrees.length > 0}
        />
      </div>
    </aside>
  );
}

function matchesTask(task: (typeof tasks)[number], query: string) {
  return [
    task.key,
    task.title,
    task.worktree?.name,
    task.worktree?.branch,
    task.pullRequest &&
      formatPullRequestReference(task.pullRequest.provider, task.pullRequest.number),
    ...task.runningAgents.flatMap((agent) => [agentHarnesses[agent.harness].title, agent.title]),
  ]
    .filter(Boolean)
    .some((value) => value?.toLowerCase().includes(query));
}

function matchesWorktree(worktree: WorktreeProjection, query: string) {
  const number = worktree.pr?.ref.provider === "github" ? `#${worktree.pr.ref.number}` : undefined;

  return [
    worktree.name,
    worktree.branch,
    worktree.pr?.title,
    number,
    worktree.pr?.state,
    worktree.state,
  ]
    .filter(Boolean)
    .some((value) => value?.toLowerCase().includes(query));
}

function TaskSearch({ query, onChange }: { query: string; onChange: (value: string) => void }) {
  return (
    <label className="mx-3 my-3 flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-muted-foreground focus-within:ring-2 focus-within:ring-ring/50">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0" fill="none">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      <input
        aria-label="Filter tasks"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter tasks…"
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => onChange("")}
          className="rounded px-1 text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          ×
        </button>
      ) : null}
    </label>
  );
}

function WorktreesSection({
  data,
  worktrees,
  query,
}: {
  data: ReturnType<typeof useWorktrees>;
  worktrees: WorktreeProjection[];
  query: string;
}) {
  return (
    <section className="pt-1">
      <div className="flex items-center justify-between px-2.5 py-2">
        <h3 className="text-xs font-semibold">Worktrees</h3>
        <div className="flex items-center gap-2">
          {data.stale ? <span className="text-[10px] text-attention">Stale</span> : null}
          <button
            type="button"
            onClick={data.refresh}
            disabled={data.loading}
            aria-label="Refresh worktree pull request state"
            title="Refresh worktree pull request state"
            className="rounded px-1.5 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {data.loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>
      {data.error ? (
        <p role="alert" className="mx-2.5 mb-2 text-xs text-destructive">
          {data.error}
        </p>
      ) : null}
      {data.loading && worktrees.length === 0 ? <LoadingWorktrees /> : null}
      {worktrees.map((worktree) => (
        <WorktreeCard
          key={`${worktree.name}:${worktree.branch ?? "detached"}`}
          worktree={worktree}
        />
      ))}
      {!data.loading && worktrees.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {query ? "No matching worktrees" : "No worktrees found."}
        </p>
      ) : null}
      {data.refreshedAt ? (
        <p className="px-3 py-1 text-[10px] text-muted-foreground">
          Updated {new Date(data.refreshedAt).toLocaleTimeString()}
        </p>
      ) : null}
    </section>
  );
}

function LoadingWorktrees() {
  return (
    <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
      Loading worktrees…
    </p>
  );
}

function TasksSection({
  activeTasks,
  inactiveTasks,
  selectedTaskKey,
  onSelectTask,
  inactiveExpanded,
  onToggleInactive,
  hasMatches,
}: {
  activeTasks: typeof tasks;
  inactiveTasks: typeof tasks;
  selectedTaskKey: string;
  onSelectTask: (key: string) => void;
  inactiveExpanded: boolean;
  onToggleInactive: () => void;
  hasMatches: boolean;
}) {
  return (
    <>
      {activeTasks.map((task) => (
        <TaskCard
          key={task.key}
          task={task}
          selected={selectedTaskKey === task.key}
          onSelect={() => onSelectTask(task.key)}
        />
      ))}
      {inactiveTasks.length > 0 ? (
        <InactiveTasks
          tasks={inactiveTasks}
          selectedTaskKey={selectedTaskKey}
          onSelectTask={onSelectTask}
          expanded={inactiveExpanded}
          onToggle={onToggleInactive}
        />
      ) : null}
      {!hasMatches ? (
        <p className="px-3 py-8 text-center text-xs text-muted-foreground">No matching tasks</p>
      ) : null}
    </>
  );
}

function InactiveTasks({
  tasks: inactiveTasks,
  selectedTaskKey,
  onSelectTask,
  expanded,
  onToggle,
}: {
  tasks: typeof tasks;
  selectedTaskKey: string;
  onSelectTask: (key: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="pt-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="inactive-tasks"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className={`size-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none"
        >
          <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className="flex-1">Inactive</span>
        <span className="font-mono">{inactiveTasks.length}</span>
      </button>
      <div id="inactive-tasks" hidden={!expanded} className="space-y-1.5">
        {inactiveTasks.map((task) => (
          <TaskCard
            key={task.key}
            task={task}
            selected={selectedTaskKey === task.key}
            onSelect={() => onSelectTask(task.key)}
          />
        ))}
      </div>
    </section>
  );
}

function WorktreeCard({ worktree }: { worktree: WorktreeProjection }) {
  const prNumber =
    worktree.pr?.ref.provider === "github" ? `#${worktree.pr.ref.number}` : undefined;
  const checkState = worktree.checks?.length
    ? summarizeChecks(worktree.checks.map((check) => check.state))
    : undefined;
  const reviewState = worktree.reviews?.length
    ? `${worktree.reviews.length} review${worktree.reviews.length === 1 ? "" : "s"}`
    : undefined;
  const externalUrl = safeGitHubUrl(worktree.pr?.url);

  return (
    <article className="mx-1.5 mb-1.5 rounded-md border border-sidebar-border/70 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{worktree.name}</span>
        {worktree.stale ? <span className="text-[10px] text-attention">Stale</span> : null}
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
        {worktree.branch ?? "Detached HEAD"}
      </p>
      <WorktreeDetails
        worktree={worktree}
        prNumber={prNumber}
        externalUrl={externalUrl}
        reviewState={reviewState}
        checkState={checkState}
      />
    </article>
  );
}

function WorktreeDetails({
  worktree,
  prNumber,
  externalUrl,
  reviewState,
  checkState,
}: {
  worktree: WorktreeProjection;
  prNumber?: string;
  externalUrl?: string;
  reviewState?: string;
  checkState?: string;
}) {
  return (
    <>
      {worktree.pr ? (
        <WorktreePullRequest
          worktree={worktree}
          prNumber={prNumber}
          externalUrl={externalUrl}
          reviewState={reviewState}
          checkState={checkState}
        />
      ) : (
        <p className="mt-1.5 text-[10px] text-muted-foreground">{worktreeStateLabel(worktree)}</p>
      )}
      {worktree.failure ? <WorktreeFailure failure={worktree.failure} /> : null}
    </>
  );
}

function WorktreePullRequest({
  worktree,
  prNumber,
  externalUrl,
  reviewState,
  checkState,
}: {
  worktree: WorktreeProjection;
  prNumber?: string;
  externalUrl?: string;
  reviewState?: string;
  checkState?: string;
}) {
  if (!worktree.pr) return null;

  const title = `${prNumber} · ${worktree.pr.title}`;
  const state = [
    worktree.pr.state,
    worktree.pr.isDraft ? "draft" : undefined,
    reviewState,
    checkState ? `CI ${checkState}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mt-1.5 space-y-1 text-xs">
      <p className="truncate">
        {externalUrl ? (
          <a
            href={externalUrl}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
          >
            {title}
          </a>
        ) : (
          title
        )}
      </p>
      <p className="text-[10px] text-muted-foreground">{state}</p>
    </div>
  );
}

function WorktreeFailure({ failure }: { failure: NonNullable<WorktreeProjection["failure"]> }) {
  return <p className="mt-1 text-[10px] text-attention">{failureLabel(failure)}</p>;
}

function worktreeStateLabel(worktree: WorktreeProjection) {
  if (worktree.state === "no-branch") return "No checked-out branch";
  if (worktree.state === "no-pr") return "No associated PR";
  if (worktree.state === "ambiguous") return "Multiple matching PRs or repositories";
  if (worktree.state === "unsupported") return "PR provider unsupported";

  return "PR state unavailable";
}

function failureLabel(failure: NonNullable<WorktreeProjection["failure"]>) {
  if (failure === "authentication") return "Provider authentication required";
  if (failure === "access-denied") return "Provider access denied";

  return "Provider data incomplete";
}

function summarizeChecks(states: string[]) {
  if (states.some((state) => state === "failed" || state === "cancelled")) return "failing";
  if (states.some((state) => state === "pending" || state === "running" || state === "unknown"))
    return "pending";

  return "passing";
}

function safeGitHubUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "github.com") return url.href;
  } catch {}
}
