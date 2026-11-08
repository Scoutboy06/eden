import type { BeadsTask } from "../../../../src/external/beads/tasks";
import type { Issue, IssueGroup } from "@/components/issue/issue";

const statusOrder = ["open", "in_progress", "blocked", "deferred", "closed"];
const beadsPriorities = ["P0", "P1", "P2", "P3", "P4"] as const;
const statuses: Record<string, { title: string; color: string }> = {
  open: { title: "Open", color: "bg-blue-500" },
  in_progress: { title: "In Progress", color: "bg-amber-500" },
  blocked: { title: "Blocked", color: "bg-red-500" },
  deferred: { title: "Deferred", color: "bg-slate-400" },
  closed: { title: "Closed", color: "bg-emerald-500" },
};

export function beadsTaskGroups(tasks: BeadsTask[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();

  for (const task of tasks) {
    const status = Object.hasOwn(statuses, task.status) ? statuses[task.status] : undefined;
    const group = groups.get(task.status) ?? {
      id: task.status,
      title: status?.title ?? task.status,
      color: status?.color ?? "bg-slate-400",
      source: {
        label: `bd list · ${task.status}`,
        detail: `bd --readonly --no-color list --all --limit 0 --sort priority --json; grouped locally by status: ${task.status}`,
      },
      items: [],
    };
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
