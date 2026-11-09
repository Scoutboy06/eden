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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Select, SelectTrigger, SelectContent, SelectItem } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { taskDraft, taskChanges, refreshedTaskDraft, type TaskDraft } from "@/pages/task-draft";

type TaskChange = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => void;
type TaskStateChange = <K extends "status" | "priority">(key: K, value: TaskDraft[K]) => void;
type TaskMetadataKey = "status" | "priority" | "assignee" | "labels";
type TaskMetadataChange = <K extends TaskMetadataKey>(
  key: K,
  value: TaskDraft[K],
) => Promise<boolean>;
type TaskOptions = { statuses: string[]; assignees: string[]; labels: string[] };
type PendingSelection = { id: string | null; trigger?: HTMLElement };
type TaskFormProps = {
  task: BeadsTaskDetail | null;
  draft: TaskDraft | null;
  editing: boolean;
  saving: boolean;
  options: TaskOptions;
  titleRef: RefObject<HTMLInputElement | null>;
  onChange: TaskChange;
  onQuickChange: TaskMetadataChange;
  onAssigneeDirtyChange: (dirty: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

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
              <Button
                variant="outline"
                size="icon-sm"
                disabled={saving}
                onClick={() => requestSelection(null)}
                aria-label="Close task"
                title="Close task"
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden />
              </Button>
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
    <Button
      ref={buttonRef}
      variant="outline"
      size="icon-sm"
      disabled={disabled}
      onClick={onEdit}
      aria-label="Edit task"
      title="Edit task"
    >
      <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} aria-hidden />
    </Button>
  );
}

function TaskForm({
  task,
  draft,
  editing,
  saving,
  options,
  titleRef,
  onChange,
  onQuickChange,
  onAssigneeDirtyChange,
  onSubmit,
}: TaskFormProps) {
  if (!task || !draft) return null;

  return (
    <form id="task-edit" className="space-y-5" onSubmit={onSubmit}>
      <fieldset disabled={saving} className="space-y-5">
        <TaskTitleField
          value={draft.title}
          editing={editing}
          titleRef={titleRef}
          onChange={(value) => onChange("title", value)}
        />
        <TaskMetadataFields
          task={task}
          options={options}
          onChange={onQuickChange}
          onAssigneeDirtyChange={onAssigneeDirtyChange}
        />
        <TaskDescriptionField
          value={draft.description}
          editing={editing}
          onChange={(value) => onChange("description", value)}
        />
        <TaskTimestamps task={task} />
      </fieldset>
    </form>
  );
}

function taskOptions(
  groups: IssueGroup[],
  statuses: string[],
  currentStatus?: string,
): TaskOptions {
  const tasks = groups.flatMap((group) => group.items);
  const nativeStatuses = currentStatus ? [currentStatus, ...statuses] : statuses;
  const assignees = tasks.flatMap((item) => (item.assignee ? [item.assignee.name] : []));
  const labels = tasks.flatMap((item) => item.labels ?? []);

  return { statuses: [...new Set(nativeStatuses)], assignees, labels };
}

function TaskEditActions({
  editing,
  saving,
  dirty,
  onCancel,
}: {
  editing: boolean;
  saving: boolean;
  dirty: boolean;
  onCancel: () => void;
}) {
  if (!editing) return null;
  const saveDisabled = saving || !dirty;

  return (
    <footer className="flex justify-end gap-2 border-t p-4">
      <Button variant="outline" disabled={saving} onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" form="task-edit" disabled={saveDisabled} className="min-w-20">
        {saving ? "Saving…" : "Save"}
      </Button>
    </footer>
  );
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
  if (!error) return loaded ? null : <p role="status">Loading task…</p>;

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

function TaskTimestamps({ task }: { task: BeadsTaskDetail }) {
  const updated = task.updated_at ? new Date(task.updated_at).toLocaleString() : null;

  return (
    <div className="space-y-1 border-t pt-4 text-xs text-muted-foreground">
      {updated && <p>Updated {updated}</p>}
      {task.comment_count !== undefined && <p>{task.comment_count} comments</p>}
    </div>
  );
}

function TaskTitleField({
  value,
  editing,
  titleRef,
  onChange,
}: {
  value: string;
  editing: boolean;
  titleRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
}) {
  if (!editing) return <h2 className="font-heading text-xl font-semibold">{value}</h2>;
  return (
    <>
      <Label htmlFor="task-title" className="sr-only">
        Title
      </Label>
      <Input
        ref={titleRef}
        id="task-title"
        value={value}
        required
        maxLength={500}
        onChange={(event) => onChange(event.target.value)}
        className="h-auto bg-muted/40 py-2 text-xl font-semibold"
      />
    </>
  );
}

function TaskDescriptionField({
  value,
  editing,
  onChange,
}: {
  value: string;
  editing: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <DetailField label="Description">
      {editing ? (
        <Textarea
          aria-label="Description"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={12}
          className="min-h-60 resize-y bg-muted/40"
        />
      ) : (
        <DetailValue>
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
            {value || "No description"}
          </p>
        </DetailValue>
      )}
    </DetailField>
  );
}

function TaskMetadataFields({
  task,
  options,
  onChange,
  onAssigneeDirtyChange,
}: {
  task: BeadsTaskDetail;
  options: TaskOptions;
  onChange: TaskMetadataChange;
  onAssigneeDirtyChange: (dirty: boolean) => void;
}) {
  const assignee = task.assignee ?? "";
  const labels = task.labels ?? [];

  return (
    <>
      <TaskStateFields value={task} statuses={options.statuses} onChange={onChange} />
      <DetailField label="Assignee">
        <AssigneeInput
          value={assignee}
          suggestions={options.assignees}
          onChange={(value) => onChange("assignee", value)}
          onDirtyChange={onAssigneeDirtyChange}
        />
      </DetailField>
      <DetailField label="Labels">
        <LabelsInput
          value={labels}
          suggestions={options.labels}
          onChange={(value) => onChange("labels", value)}
        />
      </DetailField>
    </>
  );
}

function TaskStateFields({
  value,
  statuses,
  onChange,
}: {
  value: Pick<TaskDraft, "status" | "priority">;
  statuses: string[];
  onChange: TaskStateChange;
}) {
  const priorityValue = String(value.priority);
  const priorities = [0, 1, 2, 3, 4];

  return (
    <div className="grid grid-cols-2 gap-4">
      <DetailField label="Status">
        <Select
          value={value.status}
          onValueChange={(value) => {
            if (value) onChange("status", value);
          }}
        >
          <SelectTrigger aria-label="Status" className="w-full bg-muted/40">
            {value.status}
          </SelectTrigger>
          <SelectContent>
            {statuses.map((status) => (
              <SelectItem key={status} value={status}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </DetailField>
      <DetailField label="Priority">
        <Select
          value={priorityValue}
          onValueChange={(value) => {
            if (value !== null) {
              const priority = Number(value) as TaskDraft["priority"];
              onChange("priority", priority);
            }
          }}
        >
          <SelectTrigger aria-label="Priority" className="w-full bg-muted/40">
            P{value.priority}
          </SelectTrigger>
          <SelectContent>
            {priorities.map((priority) => (
              <SelectItem key={priority} value={String(priority)}>
                P{priority}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </DetailField>
    </div>
  );
}

function DetailValue({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-9 rounded-lg border border-input bg-muted/40 px-3 py-2">{children}</div>
  );
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div>{children}</div>
    </div>
  );
}

function AssigneeInput({
  value,
  suggestions,
  onChange,
  onDirtyChange,
}: {
  value: string;
  suggestions: string[];
  onChange: (value: string) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [query, setQuery] = useState(value);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const items = [...new Set([...suggestions, ...(query.trim() ? [query.trim()] : [])])].sort();
  const dirty = query.trim() !== value;

  useEffect(() => setQuery(value), [value]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  function finish() {
    setOpen(false);
    inputRef.current?.focus();
    setEditing(false);
  }

  async function saveAssignee() {
    if (saving) return;
    const assignee = query.trim();
    setSaving(true);
    const saved = await onChange(assignee);
    setSaving(false);
    if (saved) finish();
  }

  return (
    <div className="space-y-2" role="group" aria-label="Assignee editor">
      <Combobox
        modal={false}
        open={open}
        onOpenChange={setOpen}
        items={items}
        value={query || null}
        inputValue={query}
        onInputValueChange={(text) => {
          setQuery(text);
          setEditing(true);
          if (!text) setOpen(false);
        }}
        onValueChange={(next) => {
          setQuery(next ?? "");
          setEditing(true);
          setOpen(false);
        }}
      >
        <ComboboxInput
          ref={inputRef}
          aria-label="Assignee"
          placeholder="Unassigned"
          className="w-full bg-muted/40"
          onFocus={() => setEditing(true)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            if (event.currentTarget.getAttribute("aria-activedescendant")) return;
            event.preventDefault();
            setOpen(false);
          }}
        />
        <ComboboxContent side="top">
          <ComboboxList>
            {(name: string) => (
              <ComboboxItem key={name} value={name}>
                {name}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {editing && (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => {
              setQuery(value);
              finish();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="min-w-20"
            disabled={saving}
            onClick={() => void saveAssignee()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

function LabelsInput({
  value,
  suggestions,
  onChange,
}: {
  value: string[];
  suggestions: string[];
  onChange: (value: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const anchor = useComboboxAnchor();
  const items = [
    ...new Set([...suggestions, ...value, ...(query.trim() ? [query.trim()] : [])]),
  ].sort();
  return (
    <Combobox
      multiple
      items={items}
      value={value}
      inputValue={query}
      onInputValueChange={setQuery}
      onValueChange={(next) => {
        onChange(next);
        setQuery("");
      }}
    >
      <ComboboxChips ref={anchor} className="bg-muted/40">
        {value.map((label) => (
          <ComboboxChip key={label} aria-label={label}>
            {label}
          </ComboboxChip>
        ))}
        <ComboboxChipsInput
          aria-label="Labels"
          placeholder="Add a label…"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.currentTarget.getAttribute("aria-activedescendant") &&
              query.trim() &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              onChange([...new Set([...value, query.trim()])]);
              setQuery("");
            }
          }}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxList>
          {(label: string) => (
            <ComboboxItem key={label} value={label}>
              {label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

async function taskRequest(
  project: string,
  id: string,
  options: RequestInit = {},
): Promise<{ task: BeadsTaskDetail; statuses?: string[] }> {
  const response = await fetch(
    `/api/tasks/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`,
    options,
  );
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Task API unavailable. Use Eden’s Vite dev or preview server.");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Could not load or save task.");
  return result;
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load or save task.";
}
