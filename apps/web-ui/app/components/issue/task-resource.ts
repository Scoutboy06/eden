import { useEffect, useState } from "react";

import type { BeadsTaskDetail } from "../../../../../src/external/beads/task-detail";
import { cacheTaskDetail, cachedTaskDetail, hydrateTaskDetail } from "@/pages/task-cache";

export function useTaskResource(project: string, id: string | null, revision: number) {
  const [task, setTask] = useState<BeadsTaskDetail | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!id) {
      setTask(null);
      setStatuses([]);
      setStale(false);
      return;
    }
    const controller = new AbortController();
    const cached = cachedTaskDetail(project, id);
    if (cached) {
      setTask(cached.value);
      setStale(true);
    } else {
      setTask(null);
      setStale(false);
    }
    setError(null);

    void hydrateTaskDetail(project, id).then((snapshot) => {
      if (controller.signal.aborted || !snapshot) return;
      setTask((current) => current ?? snapshot.value);
      setStale((current) => current || !cachedTaskDetail(project, id));
    });

    async function load(taskId: string) {
      try {
        const request = { signal: controller.signal };
        const result = await taskRequest(project, taskId, request);
        if (controller.signal.aborted) return;

        setTask(result.task);
        setStatuses(result.statuses ?? []);
        setStale(false);
      } catch (cause) {
        if (!controller.signal.aborted) setError(message(cause));
      }
    }

    void load(id);
    return () => controller.abort();
  }, [project, id, revision]);

  function setCanonicalTask(value: BeadsTaskDetail | null) {
    setTask(value);
    setStale(false);
  }

  return { task, statuses, error, stale, setTask: setCanonicalTask, setError };
}

export async function taskRequest(
  project: string,
  id: string,
  options: RequestInit = {},
): Promise<{ task: BeadsTaskDetail; statuses?: string[] }> {
  const taskId = encodeURIComponent(id);
  const projectId = encodeURIComponent(project);
  const url = `/api/tasks/${taskId}?project=${projectId}`;
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    throw new TaskRequestError(message(cause), true);
  }
  const contentType = response.headers.get("content-type");
  const isJsonResponse = contentType?.includes("application/json") ?? false;

  if (!isJsonResponse) {
    throw new TaskRequestError(
      "Task API unavailable. Use Eden’s Vite dev or preview server.",
      true,
    );
  }

  let result: { task: BeadsTaskDetail; statuses?: string[]; error?: string };
  try {
    result = (await response.json()) as typeof result;
  } catch {
    throw new TaskRequestError("The server response could not be confirmed.", true);
  }
  if (!response.ok) {
    const errorMessage = result.error ?? "Could not load or save task.";
    throw new TaskRequestError(errorMessage, response.status >= 500);
  }

  if (result.task) cacheTaskDetail(project, result.task);
  return result;
}

export class TaskRequestError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean,
  ) {
    super(message);
  }
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load or save task.";
}
