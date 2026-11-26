import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import type { BeadsTask } from "../../../../src/external/beads/tasks";
import type { IssueGroup } from "@/components/issue/issue";
import { beadsTaskGroups } from "@/pages/beads-data";
import {
  cachedTaskGroups,
  cacheTaskGroups,
  hydrateTaskGroups,
  taskGroupsSnapshot,
} from "@/pages/task-cache";

export function useBeadsTasks() {
  const { project = "" } = useParams();
  const [result, setResult] = useState<{
    project: string;
    groups: IssueGroup[];
    loading: boolean;
    error: string | null;
    stale: boolean;
    savedAt: number | null;
  }>({ project: "", groups: [], loading: true, error: null, stale: false, savedAt: null });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const cached = taskGroupsSnapshot(project);
    setResult({
      project,
      groups: cached?.value ?? [],
      loading: cached === undefined,
      error: null,
      stale: cached !== undefined,
      savedAt: cached?.savedAt ?? null,
    });

    void hydrateTaskGroups(project).then((snapshot) => {
      if (controller.signal.aborted || !snapshot) return;
      setResult((current) =>
        current.project !== project ||
        current.stale ||
        (!current.loading && current.savedAt !== null && current.savedAt >= snapshot.savedAt)
          ? current
          : {
              project,
              groups: snapshot.value,
              loading: false,
              error: current.error,
              stale: true,
              savedAt: snapshot.savedAt,
            },
      );
    });

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
          const snapshot = taskGroupsSnapshot(project);
          setResult({
            project,
            groups,
            loading: false,
            error: null,
            stale: false,
            savedAt: snapshot?.savedAt ?? null,
          });
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setResult({
            project,
            groups: cachedTaskGroups(project) ?? [],
            loading: false,
            error: cause instanceof Error ? cause.message : "Could not read Beads tasks.",
            stale: taskGroupsSnapshot(project) !== undefined,
            savedAt: taskGroupsSnapshot(project)?.savedAt ?? null,
          });
        }
      }
    }

    void load();
    const refreshOnReconnect = () => setRevision((value) => value + 1);
    window.addEventListener("online", refreshOnReconnect);
    return () => {
      controller.abort();
      window.removeEventListener("online", refreshOnReconnect);
    };
  }, [project, revision]);

  const current =
    result.project === project
      ? result
      : {
          project,
          groups: cachedTaskGroups(project) ?? [],
          loading: cachedTaskGroups(project) === undefined,
          error: null,
          stale: taskGroupsSnapshot(project) !== undefined,
          savedAt: taskGroupsSnapshot(project)?.savedAt ?? null,
        };
  return { ...current, refresh: () => setRevision((value) => value + 1) };
}
