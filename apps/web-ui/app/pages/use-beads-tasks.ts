import { useEffect, useState } from "react";

import type { BeadsTask } from "../../../../src/external/beads/tasks";
import type { IssueGroup } from "@/components/issue/issue";
import { beadsTaskGroups } from "@/pages/beads-data";

export function useBeadsTasks() {
  const [groups, setGroups] = useState<IssueGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const response = await fetch("/api/tasks", { signal: controller.signal });
        if (!response.headers.get("content-type")?.includes("application/json")) {
          throw new Error(
            "Task API unavailable. Run the web UI through Eden’s Vite dev or preview server.",
          );
        }
        const result = (await response.json()) as { tasks: BeadsTask[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Could not read Beads tasks.");
        if (!controller.signal.aborted) setGroups(beadsTaskGroups(result.tasks));
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not read Beads tasks.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [revision]);

  return { groups, loading, error, refresh: () => setRevision((value) => value + 1) };
}
