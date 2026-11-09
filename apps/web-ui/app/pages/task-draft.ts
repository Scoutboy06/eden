import type { BeadsTaskDetail, BeadsTaskPatch } from "../../../../src/external/beads/task-detail";

export type TaskDraft = Required<BeadsTaskPatch>;

export function refreshedTaskDraft(
  task: BeadsTaskDetail | null,
  draft: TaskDraft | null,
  editing: boolean,
): TaskDraft | null {
  if (!task) return null;
  const refreshed = taskDraft(task);
  if (!editing || !draft) return refreshed;

  return { ...refreshed, title: draft.title, description: draft.description };
}

export function taskDraft(task: BeadsTaskDetail): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee ?? "",
    labels: task.labels ?? [],
  };
}

export function taskChanges(task: BeadsTaskDetail | null, draft: TaskDraft | null): BeadsTaskPatch {
  if (!task || !draft) return {};
  const original = taskDraft(task);
  const fields = Object.entries(draft);
  const changes = fields.filter(([key, value]) => {
    const previous = original[key as keyof TaskDraft];
    const previousValue = JSON.stringify(previous);
    const nextValue = JSON.stringify(value);
    return previousValue !== nextValue;
  });

  return Object.fromEntries(changes);
}
