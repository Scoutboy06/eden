import { Link, Outlet, useParams } from "react-router-dom";

import { useProjects } from "@/pages/use-projects";

export function ProjectRoute() {
  const { project: key = "" } = useParams();
  const { projects, error } = useProjects();

  if (error)
    return (
      <main className="p-8">
        <p role="alert">{error}</p>
        <Link to="/">Project picker</Link>
      </main>
    );
  if (!projects)
    return (
      <main className="p-8" role="status">
        Loading project…
      </main>
    );
  if (!projects.some((project) => project.key === key)) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-3">
        <h1 className="text-xl">Project not found</h1>
        <Link to="/">Project picker</Link>
      </main>
    );
  }

  return <Outlet />;
}
