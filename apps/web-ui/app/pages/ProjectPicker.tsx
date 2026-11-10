import { Link } from "react-router-dom";
import { useState } from "react";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { useProjects } from "@/pages/use-projects";
import { ImportProject } from "@/components/import-project";
import { DeleteProject } from "@/components/delete-project";
import type { Project } from "@/pages/projects";

export function ProjectPicker() {
  const { projects, error } = useProjects();
  const [removing, setRemoving] = useState<Project | null>(null);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Choose a project</h1>
      <ImportProject />
      {error && <p role="alert">{error}</p>}
      {projects?.length === 0 && <p role="status">No projects are configured.</p>}
      {projects === null && !error && <p role="status">Loading projects…</p>}
      <ul className="flex flex-wrap justify-center gap-3">
        {projects?.map(({ key, name }) => (
          <li key={key} className="group flex items-center rounded-lg border">
            <Link
              className="rounded-lg px-5 py-3 hover:bg-muted"
              to={`/p/${encodeURIComponent(key)}`}
            >
              {name}
            </Link>
            <button
              type="button"
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              onClick={() => setRemoving({ key, name })}
              className="mr-2 rounded p-2 text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <DeleteProject project={removing} onClose={() => setRemoving(null)} />
    </main>
  );
}
