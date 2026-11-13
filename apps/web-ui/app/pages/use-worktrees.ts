import { useEffect, useState } from "react";

import {
  fetchWorktrees,
  preserveStaleWorktreeData,
  type WorktreeProjection,
} from "@/pages/worktrees";
import { cachedWorktrees, cacheWorktrees } from "@/pages/worktrees-cache";

export function useWorktrees(project: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    project: string;
    worktrees: WorktreeProjection[];
    refreshedAt: string | null;
    loading: boolean;
    stale: boolean;
    error: string | null;
  }>({
    project: "",
    worktrees: [],
    refreshedAt: null,
    loading: true,
    stale: false,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    const cached = cachedWorktrees(project);
    setResult({
      project,
      worktrees: cached?.worktrees ?? [],
      refreshedAt: cached?.refreshedAt ?? null,
      loading: true,
      stale: cached !== undefined,
      error: null,
    });

    async function load() {
      try {
        const fresh = await fetchWorktrees(project, controller.signal);
        if (controller.signal.aborted) return;
        const worktrees = preserveStaleWorktreeData(
          fresh.worktrees,
          cachedWorktrees(project)?.worktrees ?? [],
        );
        const stale = worktrees.some((worktree) => worktree.stale);
        cacheWorktrees(project, { worktrees, refreshedAt: fresh.refreshedAt });
        setResult({
          project,
          worktrees,
          refreshedAt: fresh.refreshedAt,
          loading: false,
          stale,
          error: null,
        });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setResult({
          project,
          worktrees: cachedWorktrees(project)?.worktrees ?? [],
          refreshedAt: cachedWorktrees(project)?.refreshedAt ?? null,
          loading: false,
          stale: cachedWorktrees(project) !== undefined,
          error: cause instanceof Error ? cause.message : "Could not refresh worktree PR state.",
        });
      }
    }

    void load();
    return () => controller.abort();
  }, [project, revision]);

  const current =
    result.project === project
      ? result
      : {
          project,
          worktrees: cachedWorktrees(project)?.worktrees ?? [],
          refreshedAt: cachedWorktrees(project)?.refreshedAt ?? null,
          loading: true,
          stale: cachedWorktrees(project) !== undefined,
          error: null,
        };

  return { ...current, refresh: () => setRevision((value) => value + 1) };
}
