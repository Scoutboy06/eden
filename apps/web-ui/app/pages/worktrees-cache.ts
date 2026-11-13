import type { WorktreeProjection } from "@/pages/worktrees";

type WorktreeSnapshot = { worktrees: WorktreeProjection[]; refreshedAt: string };

const snapshots = new Map<string, WorktreeSnapshot>();

export function cachedWorktrees(project: string) {
  return snapshots.get(project);
}

export function cacheWorktrees(project: string, snapshot: WorktreeSnapshot) {
  snapshots.set(project, snapshot);
}
