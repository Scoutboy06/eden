import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";

import type { BeadsTaskDetail } from "../../../../../src/external/beads/task-detail";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { TaskDraft } from "@/pages/task-draft";

type TaskChange = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => void;
type TaskStateChange = <K extends "status" | "priority">(key: K, value: TaskDraft[K]) => void;
export type TaskMetadataKey = "status" | "priority" | "assignee" | "labels";
type TaskMetadataChange = <K extends TaskMetadataKey>(
  key: K,
  value: TaskDraft[K],
) => Promise<boolean>;
export type TaskOptions = { statuses: string[]; assignees: string[]; labels: string[] };
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

export function TaskForm({
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

export function TaskEditActions({
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
  let content: ReactNode;
  if (editing) {
    content = (
      <Textarea
        aria-label="Description"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={12}
        className="min-h-60 resize-y bg-muted/40"
      />
    );
  } else {
    const description = value || "No description";
    content = (
      <DetailValue>
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </DetailValue>
    );
  }

  return <DetailField label="Description">{content}</DetailField>;
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
  const trimmedQuery = query.trim();
  const querySuggestion = trimmedQuery ? [trimmedQuery] : [];
  const items = [...new Set([...suggestions, ...querySuggestion])].sort();
  const dirty = trimmedQuery !== value;

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

export function LabelsInput({
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
