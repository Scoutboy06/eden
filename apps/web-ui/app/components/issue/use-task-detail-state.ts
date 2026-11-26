import { useState } from "react";

import type { TaskDraft } from "@/pages/task-draft";

type PendingSelection = { id: string | null; trigger?: HTMLElement };

export function useTaskDetailState() {
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [assigneeDirty, setAssigneeDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconciliationRequired, setReconciliationRequired] = useState(false);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [revision, setRevision] = useState(0);

  return {
    selected,
    setSelected,
    draft,
    setDraft,
    editing,
    setEditing,
    assigneeDirty,
    setAssigneeDirty,
    saving,
    setSaving,
    reconciling,
    setReconciling,
    reconciliationRequired,
    setReconciliationRequired,
    pending,
    setPending,
    revision,
    setRevision,
  };
}
