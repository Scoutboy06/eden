import type { RefObject } from "react";

import type {
  BeadsTaskDetail,
  BeadsTaskPatch,
} from "../../../../../src/external/beads/task-detail";
import type { IssueGroup } from "@/components/issue/issue";
import { taskDraft, type TaskDraft } from "@/pages/task-draft";
import { projectTaskPatch } from "@/pages/task-cache";
import { taskRequest, TaskRequestError } from "@/components/issue/task-resource";

export type SaveTaskEditsOptions = {
  task: BeadsTaskDetail | null;
  patch: BeadsTaskPatch;
  focusEditor: boolean;
  project: string;
  groups: IssueGroup[];
  saving: boolean;
  reconciliationRequired: boolean;
  setSaving: (value: boolean) => void;
  setReconciling: (value: boolean) => void;
  setReconciliationRequired: (value: boolean) => void;
  setTask: (task: BeadsTaskDetail | null) => void;
  setDraft: (draft: TaskDraft) => void;
  setEditing: (editing: boolean) => void;
  setError: (error: string | null) => void;
  onProjectGroups: (update: (groups: IssueGroup[]) => IssueGroup[]) => void;
  onSaved: () => void;
  editRef: RefObject<HTMLButtonElement | null>;
};

export async function saveTaskEdits({
  task,
  patch,
  focusEditor,
  project,
  groups,
  saving,
  reconciliationRequired,
  setSaving,
  setReconciling,
  setReconciliationRequired,
  setTask,
  setDraft,
  setEditing,
  setError,
  onProjectGroups,
  onSaved,
  editRef,
}: SaveTaskEditsOptions) {
  if (!task || saving || reconciliationRequired) return false;
  if (!navigator.onLine) {
    setError("You are offline. Your edits remain unsaved; reconnect before saving.");
    return false;
  }

  const previous = task;
  onProjectGroups((current) => projectTaskPatch(current, task.id, patch));
  setTask({ ...task, ...patch });
  setSaving(true);
  setError(null);
  try {
    const result = await taskRequest(project, task.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setTask(result.task);
    onProjectGroups((current) =>
      projectTaskPatch(current, task.id, {
        title: result.task.title,
        status: result.task.status,
        priority: result.task.priority,
        assignee: result.task.assignee ?? "",
        labels: result.task.labels,
      }),
    );
    if (focusEditor) settleTaskEditor(result.task, setDraft, setEditing, editRef);
    onSaved();
    return true;
  } catch (cause) {
    await handleTaskSaveFailure({
      cause,
      project,
      taskId: task.id,
      groups,
      onProjectGroups,
      setTask,
      onSaved,
      setError,
      setReconciling,
      setReconciliationRequired,
      previous,
    });
    return false;
  } finally {
    setSaving(false);
  }
}

function settleTaskEditor(
  task: BeadsTaskDetail,
  setDraft: (draft: TaskDraft) => void,
  setEditing: (editing: boolean) => void,
  editRef: RefObject<HTMLButtonElement | null>,
) {
  setDraft(taskDraft(task));
  setEditing(false);
  requestAnimationFrame(() => editRef.current?.focus());
}

async function handleTaskSaveFailure({
  cause,
  project,
  taskId,
  groups,
  onProjectGroups,
  setTask,
  onSaved,
  setError,
  setReconciling,
  setReconciliationRequired,
  previous,
}: {
  cause: unknown;
  project: string;
  taskId: string;
  groups: IssueGroup[];
  onProjectGroups: (update: (groups: IssueGroup[]) => IssueGroup[]) => void;
  setTask: (task: BeadsTaskDetail | null) => void;
  onSaved: () => void;
  setError: (error: string | null) => void;
  setReconciling: (value: boolean) => void;
  setReconciliationRequired: (value: boolean) => void;
  previous: BeadsTaskDetail;
}) {
  onProjectGroups(() => groups);
  setTask(previous);
  if (cause instanceof TaskRequestError && cause.ambiguous) {
    await reconcileAfterAmbiguousUpdate({
      project,
      taskId,
      setTask,
      onSaved,
      setError,
      setReconciling,
      setReconciliationRequired,
    });
    return;
  }
  setError(message(cause));
}

async function reconcileAfterAmbiguousUpdate({
  project,
  taskId,
  setTask,
  onSaved,
  setError,
  setReconciling,
  setReconciliationRequired,
}: {
  project: string;
  taskId: string;
  setTask: (task: BeadsTaskDetail | null) => void;
  onSaved: () => void;
  setError: (error: string | null) => void;
  setReconciling: (value: boolean) => void;
  setReconciliationRequired: (value: boolean) => void;
}) {
  setReconciliationRequired(true);
  setReconciling(true);
  try {
    const result = await taskRequest(project, taskId);
    setTask(result.task);
    onSaved();
    setReconciliationRequired(false);
    setError(
      "Update outcome was uncertain. The task was refreshed; review your draft before retrying.",
    );
  } catch {
    setError("Update outcome is uncertain. Refresh task details before retrying.");
  } finally {
    setReconciling(false);
  }
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load or save task.";
}
