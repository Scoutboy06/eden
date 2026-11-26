import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { listConversationSummaries, type ConversationSummary } from "@/pages/conversations";
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
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);

  useEffect(() => {
    if (!open || !project) return;
    const controller = new AbortController();
    const refreshSummaries = () => {
      void listConversationSummaries(project, controller.signal)
        .then(({ summaries: fresh }) => setSummaries(fresh))
        .catch(() => {});
    };
    refreshSummaries();
    const interval = window.setInterval(refreshSummaries, 30_000);
    window.addEventListener("focus", refreshSummaries);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshSummaries);
    };
  }, [open, project]);

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
      <WorktreesContent
        worktrees={worktrees}
        summaries={summaries}
        loading={loading}
        stale={stale}
        error={error}
        refreshedAt={refreshedAt}
        refresh={refresh}
        selectedWorktreeKey={selectedWorktreeKey}
        onSelect={openWorktree}
      />
    </aside>
  );
}

function WorktreesContent({
  worktrees,
  summaries,
  loading,
  stale,
  error,
  refreshedAt,
  refresh,
  selectedWorktreeKey,
  onSelect,
}: {
  worktrees: WorktreeProjection[];
  summaries: ConversationSummary[];
  loading: boolean;
  stale: boolean;
  error: string | null;
  refreshedAt: string | null;
  refresh: () => void;
  selectedWorktreeKey: string | null;
  onSelect: (worktree: WorktreeProjection) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <section>
        <div className="flex items-center justify-end px-2 py-1">
          <WorktreeRefreshButton loading={loading} stale={stale} refresh={refresh} />
        </div>
        {error ? (
          <p role="alert" className="mx-2.5 mb-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <WorktreeResults
          worktrees={worktrees}
          summaries={summaries}
          loading={loading}
          selectedWorktreeKey={selectedWorktreeKey}
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
  summaries,
  loading,
  selectedWorktreeKey,
  onSelect,
}: {
  worktrees: WorktreeProjection[];
  summaries: ConversationSummary[];
  loading: boolean;
  selectedWorktreeKey: string | null;
  onSelect: (worktree: WorktreeProjection) => void;
}) {
  if (loading && worktrees.length === 0) return <LoadingWorktrees />;
  if (worktrees.length === 0) return <EmptyWorktrees />;

  return worktrees.map((worktree) => (
    <WorktreeCard
      key={`${worktree.name}:${worktree.branch ?? "detached"}`}
      worktree={worktree}
      conversations={summaries.filter(
        (summary) => summary.worktree === worktree.name && summary.branch === worktree.branch,
      )}
      selected={selectedWorktreeKey === worktreeSelectionKey(worktree)}
      onSelect={() => onSelect(worktree)}
    />
  ));
}

function EmptyWorktrees() {
  return <p className="px-3 py-2 text-xs text-muted-foreground">No worktrees found.</p>;
}

function RefreshTime({ value }: { value: string }) {
  return (
    <p className="px-3 py-1 text-[10px] text-muted-foreground">
      Updated {new Date(value).toLocaleTimeString()}
    </p>
  );
}

function LoadingWorktrees() {
  return (
    <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
      Loading worktrees…
    </p>
  );
}
