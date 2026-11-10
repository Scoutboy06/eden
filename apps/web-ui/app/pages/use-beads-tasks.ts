import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import type { BeadsTask } from "../../../../src/external/beads/tasks";
import type { IssueGroup } from "@/components/issue/issue";
import { beadsTaskGroups } from "@/pages/beads-data";
import { cachedTaskGroups, cacheTaskGroups } from "@/pages/task-cache";

export function useBeadsTasks() {
  const { project = "" } = useParams();
  const [result, setResult] = useState<{
    project: string;
    groups: IssueGroup[];
    loading: boolean;
    error: string | null;
  }>({ project: "", groups: [], loading: true, error: null });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const cached = cachedTaskGroups(project);
    setResult({ project, groups: cached ?? [], loading: cached === undefined, error: null });

    async function load() {
      try {
        const response = await fetch(`/api/tasks?project=${encodeURIComponent(project)}`, {
          signal: controller.signal,
        });
        if (!response.headers.get("content-type")?.includes("application/json")) {
          throw new Error(
            "Task API unavailable. Run the web UI through Eden’s Vite dev or preview server.",
          );
        }
        const result = (await response.json()) as { tasks: BeadsTask[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Could not read Beads tasks.");
        if (!controller.signal.aborted) {
          const groups = beadsTaskGroups(result.tasks);
          cacheTaskGroups(project, groups);
          setResult({
            project,
            groups,
            loading: false,
            error: null,
          });
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setResult({
            project,
            groups: cachedTaskGroups(project) ?? [],
            loading: false,
            error: cause instanceof Error ? cause.message : "Could not read Beads tasks.",
          });
        }
      }
    }

    void load();
    return () => controller.abort();
  }, [project, revision]);

  const current =
    result.project === project
      ? result
      : {
          project,
          groups: cachedTaskGroups(project) ?? [],
          loading: cachedTaskGroups(project) === undefined,
          error: null,
        };
  return { ...current, refresh: () => setRevision((value) => value + 1) };
}
