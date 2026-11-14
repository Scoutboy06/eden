import type { WorktreeProjection } from "@/pages/worktrees";

export type WorktreeSelections = Record<string, string>;

export function worktreeSelectionKey(worktree: WorktreeProjection) {
  return `${worktree.name}\0${worktree.branch ?? ""}`;
}

export function selectedWorktree(
  worktrees: WorktreeProjection[],
  selections: WorktreeSelections,
  project: string,
) {
  const key = selections[project];

  return worktrees.find((worktree) => worktreeSelectionKey(worktree) === key) ?? null;
}

export function selectProjectWorktree(
  selections: WorktreeSelections,
  project: string,
  worktree: WorktreeProjection,
): WorktreeSelections {
  return { ...selections, [project]: worktreeSelectionKey(worktree) };
}
