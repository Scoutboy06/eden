export type PullRequestTask = {
  id: string;
  provider: "github" | "azure-devops";
  title: string;
  worktree: string;
  branch: string;
  pullRequest: number | null;
  pullRequestUrl: string | null;
  ci: "passing" | "pending" | "failing" | null;
  vote: "approved" | "suggestions" | "waiting" | "rejected" | "none";
  comments: {
    new: number;
    fixing: boolean;
    handled: number;
  };
  target: string;
  ahead: number;
  behind: number;
};

export type StackRelation = {
  parentId: string;
  childId: string;
};

export type PullRequestQueue = {
  id: string;
  name: string;
  taskIds: string[];
};

export type QueuePosition = {
  name: string;
  position: number;
};

export type ReviewRow = {
  task: PullRequestTask;
  parent: PullRequestTask | null;
};

export const pullRequestTasks: PullRequestTask[] = [
  {
    id: "CODE-20388",
    provider: "azure-devops",
    title: "Page titles: My pages and Compare",
    worktree: "localized-page-titles",
    branch: "elias/CODE-20388-page-titles",
    pullRequest: 26048,
    pullRequestUrl: "https://dev.azure.com/example/example/_git/example/pullrequest/26048",
    ci: "passing",
    vote: "waiting",
    comments: { new: 2, fixing: true, handled: 1 },
    target: "master",
    ahead: 13,
    behind: 4,
  },
  {
    id: "CODE-20039",
    provider: "azure-devops",
    title: "Checkout method endpoint types",
    worktree: "checkout-method-endpoint-types",
    branch: "elias/CODE-20039-checkout-types",
    pullRequest: 26032,
    pullRequestUrl: "https://dev.azure.com/example/example/_git/example/pullrequest/26032",
    ci: "pending",
    vote: "approved",
    comments: { new: 0, fixing: false, handled: 0 },
    target: "master",
    ahead: 21,
    behind: 2,
  },
  {
    id: "CODE-19797",
    provider: "azure-devops",
    title: "Translate store names",
    worktree: "translate-store-names",
    branch: "elias/CODE-19797-store-names",
    pullRequest: 26029,
    pullRequestUrl: "https://dev.azure.com/example/example/_git/example/pullrequest/26029",
    ci: "failing",
    vote: "suggestions",
    comments: { new: 0, fixing: false, handled: 2 },
    target: "master",
    ahead: 3,
    behind: 2,
  },
  {
    id: "CODE-20402",
    provider: "github",
    title: "Page titles: order, account, campaign",
    worktree: "translate-bundled-page-titles",
    branch: "elias/CODE-20402-bundled-titles",
    pullRequest: 26051,
    pullRequestUrl: "https://github.com/example/example/pull/26051",
    ci: "passing",
    vote: "none",
    comments: { new: 0, fixing: false, handled: 0 },
    target: "master",
    ahead: 9,
    behind: 0,
  },
  {
    id: "todo-60",
    provider: "github",
    title: "Page titles: shared bundles",
    worktree: "translate-shared-bundle-page-titles",
    branch: "elias/unticketed/shared-bundle-titles",
    pullRequest: null,
    pullRequestUrl: null,
    ci: null,
    vote: "none",
    comments: { new: 1, fixing: false, handled: 0 },
    target: "elias/CODE-20402-bundled-titles",
    ahead: 4,
    behind: 0,
  },
];

export function formatPullRequestReference(
  provider: PullRequestTask["provider"],
  pullRequest: number | null,
) {
  if (pullRequest === null) return null;

  return `${provider === "github" ? "#" : "!"}${pullRequest}`;
}

export const stackRelations: StackRelation[] = [{ parentId: "CODE-20402", childId: "todo-60" }];

export const pullRequestQueues: PullRequestQueue[] = [
  {
    id: "page-titles",
    name: "allLocales.ts",
    taskIds: ["CODE-20388", "CODE-20402", "CODE-19797"],
  },
];

export function getQueuePositions(queues: PullRequestQueue[]) {
  const positions = new Map<string, QueuePosition>();

  for (const queue of queues) {
    queue.taskIds.forEach((taskId, index) => {
      if (!positions.has(taskId)) positions.set(taskId, { name: queue.name, position: index + 1 });
    });
  }

  return positions;
}

export function deriveReviewRows(tasks: PullRequestTask[], relations: StackRelation[]) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const childIds = new Set(relations.map(({ childId }) => childId));
  const childrenByParent = new Map<string, string[]>();

  for (const { parentId, childId } of relations) {
    const children = childrenByParent.get(parentId) ?? [];
    children.push(childId);
    childrenByParent.set(parentId, children);
  }

  const rows: ReviewRow[] = [];
  const emitted = new Set<string>();

  function appendDescendants(parent: PullRequestTask, ancestorIds: Set<string>) {
    for (const childId of childrenByParent.get(parent.id) ?? []) {
      const child = tasksById.get(childId);
      if (!child || emitted.has(childId) || ancestorIds.has(childId)) continue;

      emitted.add(childId);
      rows.push({ task: child, parent });
      const nextAncestors = new Set(ancestorIds).add(childId);
      appendDescendants(child, nextAncestors);
    }
  }

  const roots = tasks.filter(
    (task) => !childIds.has(task.id) && task.pullRequest !== null && task.pullRequest > 0,
  );
  for (const task of [...roots, ...tasks]) {
    if (task.pullRequest === null || task.pullRequest <= 0 || emitted.has(task.id)) continue;

    emitted.add(task.id);
    rows.push({ task, parent: null });
    appendDescendants(task, new Set([task.id]));
  }

  return rows;
}
