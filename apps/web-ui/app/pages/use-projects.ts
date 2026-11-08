import { useEffect, useState } from "react";

import { fetchProjects, type Project } from "@/pages/projects";

export function useProjects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchProjects(controller.signal)
      .then(setProjects)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not load projects.");
      });
    return () => controller.abort();
  }, []);

  return { projects, error };
}
