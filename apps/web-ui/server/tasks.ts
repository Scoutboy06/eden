import type { IncomingMessage, ServerResponse } from "node:http";

import { listBeadsTasks } from "../../../src/external/beads/tasks";
import { createConfigService } from "../../../src/modules/config/config.service";
import { handleProjectImport } from "./import-project";
import { handleTaskDetail, taskDetails } from "./task-detail";

type Projects = Record<string, { name: string; path: string }>;

export function createTasksMiddleware(
  _cwd: string,
  readTasks: typeof listBeadsTasks = listBeadsTasks,
  readProjects: () => Promise<Record<string, { name: string; path: string }>> = async () =>
    (await createConfigService().read()).projects ?? {},
  details = taskDetails,
) {
  return async (
    request: IncomingMessage & { originalUrl?: string },
    response: ServerResponse,
    next: () => void,
  ) => {
    const url = new URL(request.originalUrl ?? request.url ?? "/", "http://eden.local");
    const detailId = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)?.[1];
    if (url.pathname !== "/api/tasks" && url.pathname !== "/api/projects" && !detailId)
      return next();

    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");

    if (isCrossOrigin(request)) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "Cross-origin task requests are not allowed." }));
      return;
    }

    if (isProjectMutation(request, url)) {
      await handleProjectImport(request, response);
      return;
    }

    if (request.method !== "GET" && !detailId) {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Tasks are read-only." }));
      return;
    }

    let projects: Projects;
    try {
      projects = await readProjects();
    } catch {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "Could not load Eden project configuration." }));
      return;
    }

    if (url.pathname === "/api/projects") {
      response.end(
        JSON.stringify({
          projects: Object.entries(projects).map(([key, project]) => ({ key, name: project.name })),
        }),
      );
      return;
    }

    const key = url.searchParams.get("project");
    const project = selectedProject(projects, key);
    if (!project) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Project not found." }));
      return;
    }

    try {
      if (detailId) {
        await handleTaskDetail(
          request,
          response,
          project.path,
          decodeURIComponent(detailId),
          details,
        );
        return;
      }
      response.end(JSON.stringify({ tasks: await readTasks(project.path) }));
    } catch (error) {
      response.statusCode = 503;
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Could not read Beads tasks.",
        }),
      );
    }
  };
}

function selectedProject(projects: Projects, key: string | null) {
  if (key === null || !Object.hasOwn(projects, key)) return undefined;
  return projects[key];
}

function isCrossOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  return (
    origin !== undefined &&
    !["http", "https"].some((scheme) => origin === `${scheme}://${request.headers.host}`)
  );
}

function isProjectMutation(request: IncomingMessage, url: URL) {
  return ["POST", "DELETE"].includes(request.method ?? "") && url.pathname === "/api/projects";
}
