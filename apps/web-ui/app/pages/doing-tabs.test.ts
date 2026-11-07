import { describe, expect, test } from "bun:test";

import type { Task } from "@/components/tasks-sidebar-data";
import { closeSessionTab, createWorkspaceTabs, type WorkspaceTabs } from "@/pages/doing-tabs";

const task: Task = {
  key: "TEST-1",
  title: "Test workspace",
  worktree: null,
  pullRequest: null,
  runningAgents: [{ id: "agent-1", harness: "codex", title: "Implement feature" }],
};

describe("workspace tabs", () => {
  test("opens existing agents without losing their session identity", () => {
    expect(createWorkspaceTabs(task)).toEqual({
      active: "agent-1",
      sessions: [{ id: "agent-1", kind: "agent", harness: "codex", title: "Implement feature" }],
    });
    expect(createWorkspaceTabs({ ...task, runningAgents: [] }).active).toBe("reviews");
  });

  test("closing an active session selects the next tab, then the previous, then Diff", () => {
    const state: WorkspaceTabs = {
      active: "first",
      sessions: [
        { id: "first", kind: "agent", title: "Agent" },
        { id: "second", kind: "terminal", title: "Terminal" },
        { id: "third", kind: "terminal", title: "Terminal" },
      ],
    };

    const next = closeSessionTab(state, "first");
    expect(next.active).toBe("second");
    const previous = closeSessionTab({ ...next, active: "third" }, "third");
    expect(previous.active).toBe("second");
    expect(closeSessionTab(previous, "second")).toEqual({ active: "diff", sessions: [] });
    expect(state.sessions).toHaveLength(3);
  });

  test("closing background sessions preserves the selected tab and fixed tabs cannot be closed", () => {
    const state = { ...createWorkspaceTabs(task), active: "reviews" };

    expect(closeSessionTab(state, "agent-1")).toEqual({ active: "reviews", sessions: [] });
    expect(closeSessionTab(state, "reviews")).toBe(state);
    expect(closeSessionTab(state, "diff")).toBe(state);
  });

  test("workspaces do not share session arrays", () => {
    const first = createWorkspaceTabs(task);
    const second = createWorkspaceTabs(task);

    first.sessions.push({ id: "terminal", kind: "terminal", title: "Terminal" });

    expect(second.sessions).toHaveLength(1);
  });
});
