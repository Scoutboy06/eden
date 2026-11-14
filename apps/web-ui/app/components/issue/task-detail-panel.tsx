import { useEffect, useRef, useState, type ReactNode, type RefObject, type FormEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";

import type {
  BeadsTaskDetail,
  BeadsTaskPatch,
} from "../../../../../src/external/beads/task-detail";
import type { IssueGroup } from "@/components/issue/issue";
import { TaskOpeningContext } from "@/components/issue/task-opening";
import { Button } from "@/components/ui/button";
import { HeaderIconButton } from "@/components/ui/header-icon-button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { taskDraft, taskChanges, refreshedTaskDraft, type TaskDraft } from "@/pages/task-draft";
import {
  TaskEditActions,
  TaskForm,
  type TaskMetadataKey,
  type TaskOptions,
} from "@/components/issue/task-detail-fields";

export { LabelsInput } from "@/components/issue/task-detail-fields";

type PendingSelection = { id: string | null; trigger?: HTMLElement };
export function TaskDetails({
  project,
  groups,
  onSaved,
  children,
}: {
  project: string;
  groups: IssueGroup[];
  onSaved: () => void;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [assigneeDirty, setAssigneeDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [revision, setRevision] = useState(0);
  const { task, statuses, error, setTask, setError } = useTaskResource(project, selected, revision);
  const titleRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnTaskId = useRef<string | null>(null);
  const changes = taskChanges(task, draft);
  const dirty = Object.keys(changes).length > 0;
  const options = taskOptions(groups, statuses, task?.status);

  function select(id: string | null, trigger?: HTMLElement) {
    if (trigger) {
      returnFocus.current = trigger;
      returnTaskId.current = id;
    }
    setSelected(id);
    setTask(null);
    setDraft(null);
    setEditing(false);
    setAssigneeDirty(false);
    setError(null);
  }

  function requestSelection(id: string | null, trigger?: HTMLElement) {
    if (saving || id === selected) return;
    if (dirty || assigneeDirty) {
      setPending({ id, trigger });
      return;
    }
    select(id, trigger);
  }

  useEffect(() => {
    setDraft((current) => refreshedTaskDraft(task, current, editing));
  }, [task, editing]);

  useEffect(() => {
    if (editing) titleRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!dirty && !saving && !assigneeDirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, saving, assigneeDirty]);

  function change<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save(patch: BeadsTaskPatch = changes, focusEditor = true) {
    if (!task || saving) return false;
    const request: RequestInit = {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    };

    setSaving(true);
    setError(null);
    try {
      const result = await taskRequest(project, task.id, request);
      setTask(result.task);
      if (focusEditor) {
        setDraft(taskDraft(result.task));
        setEditing(false);
      }
      onSaved();
      if (focusEditor) requestAnimationFrame(() => editRef.current?.focus());
      return true;
    } catch (cause) {
      setError(message(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function quickChange<K extends TaskMetadataKey>(key: K, value: TaskDraft[K]) {
    if (!task) return false;
    const previous = taskDraft(task)[key];
    const unchanged = JSON.stringify(previous) === JSON.stringify(value);
    if (unchanged) return true;
    const patch = { [key]: value };

    return save(patch, false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dirty) void save();
  }

  function changeOpen(open: boolean) {
    if (!open) requestSelection(null);
  }

  function cancelEditing() {
    if (!task) return;
    const originalDraft = taskDraft(task);

    setDraft(originalDraft);
    setEditing(false);
    setError(null);
    requestAnimationFrame(() => editRef.current?.focus());
  }

  return (
    <TaskOpeningContext value={requestSelection}>
      {children}
      <Sheet open={selected !== null} onOpenChange={changeOpen}>
        <SheetContent
          showOverlay
          showCloseButton={false}
          className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
          finalFocus={() => taskReturnFocus(returnFocus.current, returnTaskId.current)}
        >
          <SheetHeader className="flex-row items-center justify-between border-b">
            <TaskIdentity id={selected} task={task} />
            <div className="flex gap-2">
              <TaskSaveStatus saving={saving} />
              <TaskEditButton
                loaded={task !== null}
                editing={editing}
                disabled={saving}
                buttonRef={editRef}
                onEdit={() => setEditing(true)}
              />
              <HeaderIconButton
                label="Close task"
                disabled={saving}
                onClick={() => requestSelection(null)}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden />
              </HeaderIconButton>
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-5">
            <TaskLoadState
              loaded={task !== null}
              error={error}
              onRetry={() => {
                setError(null);
                setRevision((value) => value + 1);
              }}
            />
            <TaskForm
              task={task}
              draft={draft}
              editing={editing}
              saving={saving}
              options={options}
              titleRef={titleRef}
              onChange={change}
              onQuickChange={quickChange}
              onAssigneeDirtyChange={setAssigneeDirty}
              onSubmit={submit}
            />
          </div>
          <TaskEditActions
            editing={editing}
            saving={saving}
            dirty={dirty}
            onCancel={cancelEditing}
          />
        </SheetContent>
      </Sheet>
      <DiscardChangesDialog
        selection={pending}
        onCancel={() => setPending(null)}
        onDiscard={(selection) => {
          select(selection.id, selection.trigger);
          setPending(null);
        }}
      />
    </TaskOpeningContext>
  );
}

function TaskIdentity({ id, task }: { id: string | null; task: BeadsTaskDetail | null }) {
  const subtitle = task ? `${task.issue_type} · ${task.status}` : "Beads task";

  return (
    <div>
      <SheetTitle>{id}</SheetTitle>
      <SheetDescription>{subtitle}</SheetDescription>
    </div>
  );
}

function TaskSaveStatus({ saving }: { saving: boolean }) {
  return (
    <span
      role="status"
      className="flex w-16 shrink-0 items-center justify-end text-xs text-muted-foreground"
    >
      {saving ? "Saving…" : ""}
    </span>
  );
}

function TaskEditButton({
  loaded,
  editing,
  disabled,
  buttonRef,
  onEdit,
}: {
  loaded: boolean;
  editing: boolean;
  disabled: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onEdit: () => void;
}) {
  if (!loaded || editing) return null;

  return (
    <HeaderIconButton label="Edit task" ref={buttonRef} disabled={disabled} onClick={onEdit}>
      <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} aria-hidden />
    </HeaderIconButton>
  );
}

function taskOptions(
  groups: IssueGroup[],
  statuses: string[],
  currentStatus?: string,
): TaskOptions {
  const tasks = groups.flatMap((group) => group.items);
  const nativeStatuses = currentStatus ? [currentStatus, ...statuses] : statuses;
  const assignees = tasks.flatMap((task) => (task.assignee ? [task.assignee.name] : []));
  const labels = tasks.flatMap((task) => task.labels ?? []);

  return { statuses: [...new Set(nativeStatuses)], assignees, labels };
}

function TaskLoadState({
  loaded,
  error,
  onRetry,
}: {
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (!error && loaded) return null;
  if (!error) return <p role="status">Loading task…</p>;

  return (
    <>
      <p role="alert" className="mb-4 text-sm text-destructive">
        {error}
      </p>
      {!loaded && (
        <Button variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </>
  );
}

function DiscardChangesDialog({
  selection,
  onCancel,
  onDiscard,
}: {
  selection: PendingSelection | null;
  onCancel: () => void;
  onDiscard: (selection: PendingSelection) => void;
}) {
  return (
    <Dialog
      disablePointerDismissal
      open={selection !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogTitle>Discard changes?</DialogTitle>
        <DialogDescription>Your unsaved edits will be lost.</DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Keep editing
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (selection) onDiscard(selection);
            }}
          >
            Discard changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useTaskResource(project: string, id: string | null, revision: number) {
  const [task, setTask] = useState<BeadsTaskDetail | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();

    async function load(taskId: string) {
      try {
        const request = { signal: controller.signal };
        const result = await taskRequest(project, taskId, request);
        if (controller.signal.aborted) return;

        setTask(result.task);
        setStatuses(result.statuses ?? []);
      } catch (cause) {
        if (!controller.signal.aborted) setError(message(cause));
      }
    }

    void load(id);
    return () => controller.abort();
  }, [project, id, revision]);

  return { task, statuses, error, setTask, setError };
}

function taskReturnFocus(trigger: HTMLElement | null, id: string | null) {
  if (trigger?.isConnected) return trigger;
  const selector = id ? `[data-task-open="${CSS.escape(id)}"]` : "#issue-search";
  const taskTrigger = document.querySelector<HTMLElement>(selector);
  const fallback = document.querySelector<HTMLElement>("#issue-search");

  return taskTrigger ?? fallback;
}

async function taskRequest(
  project: string,
  id: string,
  options: RequestInit = {},
): Promise<{ task: BeadsTaskDetail; statuses?: string[] }> {
  const taskId = encodeURIComponent(id);
  const projectId = encodeURIComponent(project);
  const url = `/api/tasks/${taskId}?project=${projectId}`;
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type");
  const isJsonResponse = contentType?.includes("application/json") ?? false;

  if (!isJsonResponse) {
    throw new Error("Task API unavailable. Use Eden’s Vite dev or preview server.");
  }

  const result = await response.json();
  if (!response.ok) {
    const errorMessage = result.error ?? "Could not load or save task.";
    throw new Error(errorMessage);
  }

  return result;
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load or save task.";
}
