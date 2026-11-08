import { useState } from "react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ImportProject({
  open: controlledOpen,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, ...(name.trim() ? { name } : {}) }),
      });
      const result = (await response.json()) as { project?: { key: string }; error?: string };
      if (!response.ok || !result.project)
        throw new Error(result.error ?? "Could not import project.");
      setOpen(false);
      setPath("");
      setName("");
      window.dispatchEvent(new Event("eden:projects-changed"));
      navigate(`/p/${encodeURIComponent(result.project.key)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import project.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next);
          setError(null);
        }
      }}
    >
      {controlledOpen === undefined && (
        <DialogTrigger
          render={<Button variant="outline" aria-label="Import project" title="Import project" />}
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          Import project
        </DialogTrigger>
      )}
      <DialogContent showCloseButton={!busy}>
        <DialogTitle>Import project</DialogTitle>
        <DialogDescription>
          Import an existing Git repository on this machine. No repository files will be changed.
        </DialogDescription>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            Repository path
            <input
              autoFocus
              required
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="~/src/my-project"
              disabled={busy}
              className="rounded-md border bg-background px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-2">
            Project name (optional)
            <input
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Defaults to repository name"
              disabled={busy}
              className="rounded-md border bg-background px-3 py-2"
            />
          </label>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Importing…" : "Import project"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
