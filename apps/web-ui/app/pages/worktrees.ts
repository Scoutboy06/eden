export type WorktreeProjection = {
  name: string;
  branch: string | null;
  state: "no-branch" | "no-pr" | "ambiguous" | "unsupported" | "unavailable" | "available";
  failure?: "authentication" | "access-denied" | "provider";
  stale?: boolean;
  pr?: {
    ref: { provider: "github" | "azure-devops"; number?: number; id?: number };
    title: string;
    url: string;
    state: "open" | "closed" | "merged";
    isDraft: boolean;
  };
  reviews?: { name: string; state: string }[];
  checks?: { name: string; state: string; url?: string }[];
};

export async function fetchWorktrees(project: string, signal?: AbortSignal) {
  const response = await fetch(`/api/worktrees?project=${encodeURIComponent(project)}`, { signal });
  const result = (await response.json()) as {
    worktrees?: WorktreeProjection[];
    refreshedAt?: string;
    error?: string;
  };
  if (!response.ok) throw new Error(result.error ?? "Could not refresh worktree PR state.");

  return { worktrees: result.worktrees ?? [], refreshedAt: result.refreshedAt ?? "" };
}

export function preserveStaleWorktreeData(
  current: WorktreeProjection[],
  previous: WorktreeProjection[],
): WorktreeProjection[] {
  const oldByKey = new Map(previous.map((worktree) => [worktreeKey(worktree), worktree]));

  return current.map((worktree) => {
    const old = oldByKey.get(worktreeKey(worktree));
    if (!old) return worktree;
    if (worktree.state === "unavailable" && old.pr)
      return {
        ...old,
        failure: worktree.failure,
        stale: true,
      };
    if (worktree.state !== "available" || !worktree.failure) return worktree;

    return {
      ...worktree,
      pr: worktree.pr ?? old.pr,
      reviews: worktree.reviews ?? old.reviews,
      checks: worktree.checks ?? old.checks,
      stale: worktree.reviews === undefined || worktree.checks === undefined,
    };
  });
}

function worktreeKey(worktree: WorktreeProjection) {
  return `${worktree.name}\0${worktree.branch ?? ""}`;
}
