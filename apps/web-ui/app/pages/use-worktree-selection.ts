import { useState } from "react";

import {
  selectProjectWorktree,
  selectedWorktree,
  type WorktreeSelections,
  worktreeSelectionKey,
} from "@/pages/worktree-selection";
import type { WorktreeProjection } from "@/pages/worktrees";

export function useWorktreeSelection(project: string, worktrees: WorktreeProjection[]) {
  const [selections, setSelections] = useState<WorktreeSelections>({});
  const worktree = selectedWorktree(worktrees, selections, project);

  return {
    worktree,
    key: worktree ? worktreeSelectionKey(worktree) : null,
    select: (selected: WorktreeProjection) =>
      setSelections((current) => selectProjectWorktree(current, project, selected)),
  };
}
