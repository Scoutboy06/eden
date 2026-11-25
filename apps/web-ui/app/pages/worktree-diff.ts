import type { WorktreeDiff } from "../../shared/worktree-diff";

export async function fetchWorktreeDiff(
  project: string,
  worktree: string,
  branch: string | null,
  signal?: AbortSignal,
): Promise<WorktreeDiff> {
  const query = new URLSearchParams({ project, worktree, branch: branch ?? "" });
  const response = await fetch(`/api/worktree-diff?${query}`, { signal });
  const result = (await response.json()) as WorktreeDiff & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Could not read worktree changes.");
  return result;
}
