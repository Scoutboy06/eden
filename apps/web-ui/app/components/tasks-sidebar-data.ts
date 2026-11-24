import type { CIStatusValue } from "@/components/ci-status";
import type { PullRequestTask } from "@/pages/prs-data";

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
  ci?: CIStatusValue;
  reviewCount?: number;
}
