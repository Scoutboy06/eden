import { expect, test } from "bun:test";

import { selectProjectWorktree, selectedWorktree } from "./worktree-selection";
import { createWorktreeDemoTask } from "./worktree-demo";
import type { WorktreeProjection } from "./worktrees";

const first: WorktreeProjection = {
  name: "topic",
  branch: "feature/topic",
  state: "available",
  pr: {
    ref: { provider: "github", number: 42 },
    title: "Topic",
    url: "https://github.com/acme/app/pull/42",
    state: "open",
    isDraft: false,
  },
  checks: [{ name: "build", state: "passed" }],
};

test("stores worktree selection by project and clears stale identities without selecting another", () => {
  const selected = selectProjectWorktree({}, "eden", first);

  expect(selectedWorktree([first], selected, "eden")).toBe(first);
  expect(selectedWorktree([first], selected, "other")).toBeNull();
  expect(selectedWorktree([], selected, "eden")).toBeNull();
});

test("builds a generic demo detail model from the selected live worktree identity", () => {
  expect(createWorktreeDemoTask(first, "eden")).toEqual({
    key: "worktree:eden\0topic\0feature/topic",
    title: "topic",
    worktree: { name: "topic", branch: "feature/topic" },
    pullRequest: { provider: "github", number: 42 },
    runningAgents: [],
    ci: "passing",
    reviewCount: 2,
  });
});
