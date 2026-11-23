import { useState } from "react";
import { Link } from "react-router-dom";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { ImportProject } from "@/components/import-project";
import { DeleteProject } from "@/components/delete-project";
import { useProjects } from "@/pages/use-projects";
import type { Project } from "@/pages/projects";

export function ProjectPicker() {
  const { projects, error } = useProjects();
  const [removing, setRemoving] = useState<Project | null>(null);
  const list = projects ?? [];

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-10">
          <Link
            to="/"
            className="flex items-center gap-2 font-heading text-lg font-bold tracking-tight"
          >
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-xs text-primary-foreground">
              E
            </span>
            Eden
          </Link>
        </div>
      </header>
      {error && (
        <p role="alert" className="mx-auto max-w-6xl px-6 pt-6 text-sm text-destructive">
          {error}
        </p>
      )}
      {projects === null && !error ? (
        <p role="status" className="py-24 text-center text-sm text-muted-foreground">
          Loading projects…
        </p>
      ) : (
        <ProjectPickerCatalog projects={list} onRemove={setRemoving} />
      )}
      <footer className="mx-auto flex max-w-6xl justify-between border-t px-6 py-5 text-xs text-muted-foreground sm:px-10">
        <span>Projects stay on this machine.</span>
        <span>EDEN / PROJECTS</span>
      </footer>
      <DeleteProject project={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

function ProjectPickerCatalog({
  projects,
  onRemove,
}: {
  projects: Project[];
  onRemove: (project: Project) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = projects.filter(({ name, key }) =>
    `${name} ${key}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <main className="mx-auto min-h-[75svh] max-w-5xl px-6 py-12 sm:px-10 sm:py-16">
      <div className="flex flex-col justify-between gap-8 border-b pb-8 sm:flex-row sm:items-end">
        <div>
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-primary">
            Repository index
          </p>
          <h1 className="font-heading text-4xl font-semibold tracking-tight">Project catalog</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            A clear view of every repository in your Eden setup.
          </p>
        </div>
        <ImportProject />
      </div>
      <div className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex max-w-sm flex-1 items-center gap-3 rounded-lg border bg-card px-3">
          <span aria-hidden className="text-lg text-muted-foreground">
            ⌕
          </span>
          <input
            aria-label="Search projects"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by name or key…"
            className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
        <span className="font-mono text-xs text-muted-foreground">
          {filtered.length} / {projects.length} SHOWN
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="grid grid-cols-[1fr_auto] border-b bg-muted/50 px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid-cols-[1fr_1fr_auto]">
          <span>Project</span>
          <span className="hidden sm:block">Stable key</span>
          <span>Actions</span>
        </div>
        {filtered.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {projects.length
              ? "No projects match your search."
              : "Your catalog is empty. Import a repository to start."}
          </p>
        ) : (
          filtered.map((project, index) => (
            <div
              key={project.key}
              className="grid grid-cols-[1fr_auto] items-center border-b px-4 py-3 last:border-b-0 hover:bg-muted/30 sm:grid-cols-[1fr_1fr_auto]"
            >
              <Link
                to={`/p/${encodeURIComponent(project.key)}`}
                className="flex min-w-0 items-center gap-3"
              >
                <span className="w-6 font-mono text-[10px] text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  style={{ color: `oklch(0.52 0.16 ${projectHue(project.name)})` }}
                  className="font-mono text-sm font-bold"
                >
                  {projectMark(project.name)}
                </span>
                <span className="truncate text-sm font-medium">{project.name}</span>
              </Link>
              <span className="hidden truncate pr-4 font-mono text-xs text-muted-foreground sm:block">
                {project.key}
              </span>
              <div className="flex items-center gap-1">
                <Link
                  to={`/p/${encodeURIComponent(project.key)}`}
                  className="rounded-md px-3 py-2 text-xs font-medium text-primary hover:bg-primary/10"
                >
                  Open
                </Link>
                <RemoveButton project={project} onRemove={() => onRemove(project)} />
              </div>
            </div>
          ))
        )}
      </div>
    </main>
  );
}

function projectMark(name: string) {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? name[0] ?? "?") + (words[1]?.[0] ?? name[1] ?? "")).toUpperCase();
}

function projectHue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

function RemoveButton({ project, onRemove }: { project: Project; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${project.name}`}
      title={`Remove ${project.name}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onRemove();
      }}
      className="rounded-md p-2 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} className="size-4" />
    </button>
  );
}
