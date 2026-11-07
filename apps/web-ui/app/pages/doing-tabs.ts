import type { AgentHarness, Task } from "@/components/tasks-sidebar-data";

export type SessionTab = {
  id: string;
  kind: "agent" | "terminal";
  title: string;
  harness?: AgentHarness;
};

export type WorkspaceTabs = {
  active: string;
  sessions: SessionTab[];
};

export function createWorkspaceTabs(task: Task): WorkspaceTabs {
  const sessions: SessionTab[] = task.runningAgents.map((agent) => ({
    id: agent.id,
    kind: "agent",
    title: agent.title,
    harness: agent.harness,
  }));

  return { active: sessions[0]?.id ?? "reviews", sessions };
}

export function closeSessionTab(state: WorkspaceTabs, id: string): WorkspaceTabs {
  const index = state.sessions.findIndex((tab) => tab.id === id);
  if (index === -1) return state;

  const sessions = state.sessions.filter((tab) => tab.id !== id);

  return {
    sessions,
    active:
      state.active === id
        ? (sessions[index]?.id ?? sessions[index - 1]?.id ?? "diff")
        : state.active,
  };
}
