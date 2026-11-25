import { useCallback, useEffect, useState } from "react";

import { fetchWorktreeDiff } from "@/pages/worktree-diff";
import type { WorktreeDiff } from "../../shared/worktree-diff";

export function useWorktreeDiff(
  project: string,
  worktree: string | undefined,
  branch: string | null,
  enabled: boolean,
) {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!worktree) return;
      setLoading(true);
      try {
        setDiff(await fetchWorktreeDiff(project, worktree, branch, signal));
        setError(null);
      } catch (cause) {
        if (!signal?.aborted)
          setError(cause instanceof Error ? cause.message : "Could not read worktree changes.");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [project, worktree, branch],
  );

  useEffect(() => {
    if (!enabled || !worktree) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [enabled, worktree, refresh]);

  return { diff, error, loading, refresh };
}
