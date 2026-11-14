import type { Task } from "@/components/tasks-sidebar-data";
import type { WorktreeProjection } from "@/pages/worktrees";
import { worktreeSelectionKey } from "@/pages/worktree-selection";

export function createWorktreeDemoTask(worktree: WorktreeProjection, project: string): Task {
  const checkStates = worktree.checks?.map((check) => check.state) ?? [];
  const ci =
    checkStates.length === 0
      ? undefined
      : checkStates.some((state) => state === "failed" || state === "cancelled")
        ? "failing"
        : checkStates.some(
              (state) => state === "pending" || state === "running" || state === "unknown",
            )
          ? "pending"
          : "passing";

  return {
    key: `worktree:${project}\0${worktreeSelectionKey(worktree)}`,
    title: worktree.name,
    worktree: { name: worktree.name, branch: worktree.branch },
    pullRequest:
      worktree.pr?.ref.provider === "github" && worktree.pr.ref.number !== undefined
        ? { provider: "github", number: worktree.pr.ref.number }
        : null,
    runningAgents: [],
    ...(ci ? { ci } : {}),
    ...(worktree.pr ? { reviewCount: 2 } : {}),
  };
}
