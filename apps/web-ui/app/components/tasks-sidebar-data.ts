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

export const tasks: readonly Task[] = [
  {
    key: "CODE-20388",
    title: "Page title translations",
    worktree: { name: "localized-page-titles", branch: "feature/page-title-translations" },
    pullRequest: { provider: "github", number: 26048 },
    runningAgents: [],
    reviewCount: 2,
    ci: "passing",
  },
  {
    key: "todo-60",
    title: "Shared bundle titles",
    worktree: { name: "shared-bundle-titles", branch: "work/shared-bundle-titles" },
    pullRequest: null,
    runningAgents: [
      {
        id: "shared-bundle-titles-claude",
        harness: "claude-code",
        title: "Plan shared bundle titles",
      },
      { id: "shared-bundle-titles-codex", harness: "codex", title: "Implement title resolution" },
      { id: "shared-bundle-titles-opencode", harness: "opencode", title: "Review bundle coverage" },
    ],
    ci: "pending",
  },
  {
    key: "TS-7",
    title: "TypeScript 7 readiness",
    worktree: null,
    pullRequest: null,
    runningAgents: [],
  },
  {
    key: "CODE-20094",
    title: "Error overload cleanup",
    worktree: { name: "error-overload", branch: null },
    pullRequest: { provider: "github", number: 26082 },
    runningAgents: [],
    ci: "passing",
  },
  {
    key: "CODE-19723",
    title: "Feature already in progress",
    worktree: { name: "feature-progress", branch: "feature/progress" },
    pullRequest: null,
    runningAgents: [
      {
        id: "feature-progress-claude",
        harness: "claude-code",
        title: "Investigate failing checks",
      },
    ],
    ci: "failing",
  },
  {
    key: "EDEN-41",
    title: "Polish sandbox lifecycle",
    worktree: { name: "sandbox-lifecycle", branch: "chore/sandbox-lifecycle" },
    pullRequest: { provider: "azure-devops", number: 26114 },
    runningAgents: [
      { id: "sandbox-lifecycle-codex", harness: "codex", title: "Polish sandbox lifecycle" },
    ],
    ci: "passing",
  },
];
