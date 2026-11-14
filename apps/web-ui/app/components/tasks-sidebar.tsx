import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { WorktreeCard } from "@/components/worktree-card";
import { worktreeSelectionKey } from "@/pages/worktree-selection";
import type { WorktreeProjection } from "@/pages/worktrees";

export function TasksSidebar({
  open,
  worktrees,
  loading,
  stale,
  error,
  refreshedAt,
  refresh,
  selectedWorktreeKey,
  onSelectWorktree,
}: {
  open: boolean;
  worktrees: WorktreeProjection[];
  loading: boolean;
  stale: boolean;
  error: string | null;
  refreshedAt: string | null;
  refresh: () => void;
  selectedWorktreeKey: string | null;
  onSelectWorktree: (worktree: WorktreeProjection) => void;
}) {
  const { project = "" } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredWorktrees = filterWorktrees(worktrees, normalizedQuery);

  function openWorktree(worktree: WorktreeProjection) {
    onSelectWorktree(worktree);
    void navigate(`/p/${encodeURIComponent(project)}/doing`);
  }

  return (
    <aside
      id="worktrees-sidebar"
      aria-label="Worktrees"
      aria-hidden={!open}
      className={`${open ? "flex" : "hidden"} h-svh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground sm:w-72 lg:w-80`}
    >
      <SidebarHeading count={worktrees.length} />
      <WorktreeSearch query={query} onChange={setQuery} />
      <WorktreesContent
        worktrees={filteredWorktrees}
        loading={loading}
        stale={stale}
        error={error}
        refreshedAt={refreshedAt}
        refresh={refresh}
        selectedWorktreeKey={selectedWorktreeKey}
        query={normalizedQuery}
        onSelect={openWorktree}
      />
    </aside>
  );
}

function SidebarHeading({ count }: { count: number }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border px-3">
      <h2 className="text-sm font-semibold">Worktrees</h2>
      <span className="font-mono text-xs text-muted-foreground">{count}</span>
    </div>
  );
}

function WorktreesContent({
  worktrees,
  loading,
  stale,
  error,
  refreshedAt,
  refresh,
  selectedWorktreeKey,
  query,
  onSelect,
}: {
  worktrees: WorktreeProjection[];
  loading: boolean;
  stale: boolean;
  error: string | null;
  refreshedAt: string | null;
  refresh: () => void;
  selectedWorktreeKey: string | null;
  query: string;
  onSelect: (worktree: WorktreeProjection) => void;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-3">
      <section className="pt-1">
        <div className="flex items-center justify-between px-2.5 py-2">
          <h3 className="text-xs font-semibold">Checkouts</h3>
          <WorktreeRefreshButton loading={loading} stale={stale} refresh={refresh} />
        </div>
        {error ? (
          <p role="alert" className="mx-2.5 mb-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <WorktreeResults
          worktrees={worktrees}
          loading={loading}
          selectedWorktreeKey={selectedWorktreeKey}
          query={query}
          onSelect={onSelect}
        />
        {refreshedAt ? <RefreshTime value={refreshedAt} /> : null}
      </section>
    </div>
  );
}

function WorktreeRefreshButton({
  loading,
  stale,
  refresh,
}: {
  loading: boolean;
  stale: boolean;
  refresh: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {stale ? <span className="text-[10px] text-attention">Stale</span> : null}
      <button
        type="button"
        onClick={refresh}
        disabled={loading}
        aria-label="Refresh worktree pull request state"
        title="Refresh worktree pull request state"
        className="rounded px-1.5 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
      >
        {loading ? "…" : "Refresh"}
      </button>
    </div>
  );
}

function WorktreeResults({
  worktrees,
  loading,
  selectedWorktreeKey,
  query,
  onSelect,
}: {
  worktrees: WorktreeProjection[];
  loading: boolean;
  selectedWorktreeKey: string | null;
  query: string;
  onSelect: (worktree: WorktreeProjection) => void;
}) {
  if (loading && worktrees.length === 0) return <LoadingWorktrees />;
  if (worktrees.length === 0) return <EmptyWorktrees filtered={query.length > 0} />;

  return worktrees.map((worktree) => (
    <WorktreeCard
      key={`${worktree.name}:${worktree.branch ?? "detached"}`}
      worktree={worktree}
      selected={selectedWorktreeKey === worktreeSelectionKey(worktree)}
      onSelect={() => onSelect(worktree)}
    />
  ));
}

function EmptyWorktrees({ filtered }: { filtered: boolean }) {
  return (
    <p className="px-3 py-2 text-xs text-muted-foreground">
      {filtered ? "No matching worktrees" : "No worktrees found."}
    </p>
  );
}

function RefreshTime({ value }: { value: string }) {
  return (
    <p className="px-3 py-1 text-[10px] text-muted-foreground">
      Updated {new Date(value).toLocaleTimeString()}
    </p>
  );
}

function WorktreeSearch({ query, onChange }: { query: string; onChange: (value: string) => void }) {
  return (
    <label className="mx-3 my-3 flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-muted-foreground focus-within:ring-2 focus-within:ring-ring/50">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0" fill="none">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      <input
        aria-label="Filter worktrees"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter worktrees…"
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

function LoadingWorktrees() {
  return (
    <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
      Loading worktrees…
    </p>
  );
}

function filterWorktrees(worktrees: WorktreeProjection[], query: string) {
  return worktrees.filter((worktree) => matchesWorktree(worktree, query));
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
