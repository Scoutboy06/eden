import type { CIStatusValue } from "@/components/ci-status";
import type { PullRequestTask } from "@/pages/prs-data";

export type AgentHarness = "claude-code" | "codex" | "opencode";

export const agentHarnesses: Record<AgentHarness, { title: string }> = {
  "claude-code": { title: "Claude Code" },
  codex: { title: "Codex" },
  opencode: { title: "OpenCode" },
};

export interface Task {
  key: string;
  title: string;
  worktree: {
    name: string;
    branch: string | null;
  } | null;
  pullRequest: {
    provider: PullRequestTask["provider"];
    number: number;
  } | null;
  runningAgents: readonly { id: string; harness: AgentHarness; title: string }[];
  ci?: CIStatusValue;
  reviewCount?: number;
}
