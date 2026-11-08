export type Project = { key: string; name: string };

export async function fetchProjects(signal?: AbortSignal): Promise<Project[]> {
  const response = await fetch("/api/projects", { signal });
  const result = (await response.json()) as { projects?: Project[]; error?: string };
  if (!response.ok) throw new Error(result.error ?? "Could not load projects.");
  return result.projects ?? [];
}
