import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Project } from "@/pages/projects";
import { forgetTaskGroups } from "@/pages/task-cache";

export function DeleteProject({
  project,
  onClose,
}: {
  project: Project | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { project: selected } = useParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (busy) return;
    setError(null);
    onClose();
  }

  async function remove() {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: project.key }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not remove project.");
      forgetTaskGroups(project.key);
      if (selected === project.key) navigate("/");
      window.dispatchEvent(new Event("eden:projects-changed"));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove project.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogTitle>Remove {project?.name}?</DialogTitle>
        <DialogDescription>
          This removes the project from Eden only. The repository and all its files will remain on
          disk.
        </DialogDescription>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={close} autoFocus>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove project"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
