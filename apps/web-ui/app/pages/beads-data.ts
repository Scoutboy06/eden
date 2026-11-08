import type { BeadsTask } from "../../../../src/external/beads/tasks";
import type { Issue, IssueGroup } from "@/components/issue/issue";

const statusOrder = ["open", "in_progress", "blocked", "deferred", "closed"];
const beadsPriorities = ["P0", "P1", "P2", "P3", "P4"] as const;

export function beadsTaskGroups(tasks: BeadsTask[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();

  for (const task of tasks) {
    const group = groups.get(task.status) ?? { id: task.status, title: task.status, items: [] };
    const issue: Issue = {
      id: task.id,
      key: task.id,
      title: task.title,
      type: task.issue_type,
      priority: beadsPriorities[task.priority],
      assignee: task.assignee ? { name: task.assignee } : undefined,
      labels: task.labels,
      updatedAt: task.updated_at,
      commentCount: task.comment_count,
      done: task.status === "closed",
    };
    group.items.push(issue);
    groups.set(task.status, group);
  }

  return [...groups.values()].sort(
    (a, b) => statusRank(a.id) - statusRank(b.id) || a.id.localeCompare(b.id),
  );
}

function statusRank(status: string) {
  const index = statusOrder.indexOf(status);
  return index === -1 ? statusOrder.length : index;
}
