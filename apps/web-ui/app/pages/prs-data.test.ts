import { describe, expect, test } from "bun:test";

import {
  deriveReviewRows,
  formatPullRequestReference,
  getQueuePositions,
  pullRequestTasks,
  type PullRequestTask,
} from "@/pages/prs-data";

const task = (id: string, pullRequest: number | null = 1): PullRequestTask => ({
  id,
  provider: "azure-devops",
  title: id,
  worktree: id,
  branch: id,
  pullRequest,
  pullRequestUrl:
    pullRequest === null
      ? null
      : `https://dev.azure.com/example/example/_git/example/pullrequest/${pullRequest}`,
  ci: pullRequest === null ? null : "passing",
  vote: "none",
  comments: { new: 0, fixing: false, handled: 0 },
  target: "master",
  ahead: 0,
  behind: 0,
});

describe("formatPullRequestReference", () => {
  test("uses the provider-specific prefix and omits missing pull requests", () => {
    expect(formatPullRequestReference("github", 42)).toBe("#42");
    expect(formatPullRequestReference("azure-devops", 42)).toBe("!42");
    expect(formatPullRequestReference("github", null)).toBeNull();
    expect(formatPullRequestReference("azure-devops", null)).toBeNull();
  });
});

describe("pullRequestTasks", () => {
  test("provides provider-matched sample URLs only for created pull requests", () => {
    const azurePullRequest = pullRequestTasks.find((task) => task.pullRequest === 26048);
    const githubPullRequest = pullRequestTasks.find((task) => task.pullRequest === 26051);
    const uncreatedChild = pullRequestTasks.find((task) => task.id === "todo-60");

    expect(azurePullRequest?.pullRequestUrl).toBe(
      "https://dev.azure.com/example/example/_git/example/pullrequest/26048",
    );
    expect(githubPullRequest?.pullRequestUrl).toBe("https://github.com/example/example/pull/26051");
    expect(uncreatedChild?.pullRequest).toBeNull();
    expect(uncreatedChild?.pullRequestUrl).toBeNull();
  });
});

describe("getQueuePositions", () => {
  test("uses queue source order and omits tasks outside every queue", () => {
    const positions = getQueuePositions([
      { id: "first", name: "Release", taskIds: ["a", "b"] },
      { id: "second", name: "Later", taskIds: ["c"] },
    ]);

    expect(positions.get("a")).toEqual({ name: "Release", position: 1 });
    expect(positions.get("b")).toEqual({ name: "Release", position: 2 });
    expect(positions.get("c")).toEqual({ name: "Later", position: 1 });
    expect(positions.has("outside")).toBe(false);
  });
});

describe("deriveReviewRows", () => {
  test("places stacked descendants directly after parents once, including a child PR", () => {
    const rows = deriveReviewRows(
      [task("parent"), task("child"), task("grandchild"), task("other")],
      [
        { parentId: "parent", childId: "child" },
        { parentId: "child", childId: "grandchild" },
      ],
    );

    expect(rows.map(({ task: rowTask, parent }) => [rowTask.id, parent?.id ?? null])).toEqual([
      ["parent", null],
      ["child", "parent"],
      ["grandchild", "child"],
      ["other", null],
    ]);
  });

  test("keeps an uncreated stacked child and excludes a standalone task without a PR", () => {
    const rows = deriveReviewRows(
      [task("parent"), task("child", null), task("standalone", null)],
      [{ parentId: "parent", childId: "child" }],
    );

    expect(rows.map(({ task: rowTask, parent }) => [rowTask.id, parent?.id ?? null])).toEqual([
      ["parent", null],
      ["child", "parent"],
    ]);
  });

  test("skips missing references and remains safe for relation cycles", () => {
    const rows = deriveReviewRows(
      [task("a"), task("b")],
      [
        { parentId: "a", childId: "missing" },
        { parentId: "a", childId: "b" },
        { parentId: "b", childId: "a" },
      ],
    );

    expect(rows.map(({ task: rowTask }) => rowTask.id)).toEqual(["a", "b"]);
  });
});
