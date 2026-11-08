import { Link } from "react-router-dom";

import { useProjects } from "@/pages/use-projects";
import { ImportProject } from "@/components/import-project";

export function ProjectPicker() {
  const { projects, error } = useProjects();

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Choose a project</h1>
      <ImportProject />
      {error && <p role="alert">{error}</p>}
      {projects?.length === 0 && <p role="status">No projects are configured.</p>}
      {projects === null && !error && <p role="status">Loading projects…</p>}
      <ul className="flex flex-wrap justify-center gap-3">
        {projects?.map(({ key, name }) => (
          <li key={key}>
            <Link
              className="rounded-lg border px-5 py-3 hover:bg-muted"
              to={`/p/${encodeURIComponent(key)}`}
            >
              {name}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
