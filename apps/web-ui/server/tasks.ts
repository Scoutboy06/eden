import type { IncomingMessage, ServerResponse } from "node:http";

import { listBeadsTasks } from "../../../src/external/beads/tasks";

export function createTasksMiddleware(
  cwd: string,
  readTasks: typeof listBeadsTasks = listBeadsTasks,
) {
  return async (
    request: IncomingMessage & { originalUrl?: string },
    response: ServerResponse,
    next: () => void,
  ) => {
    if ((request.originalUrl ?? request.url)?.split("?")[0] !== "/api/tasks") return next();

    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");

    if (
      request.headers.origin &&
      !["http", "https"].some(
        (scheme) => request.headers.origin === `${scheme}://${request.headers.host}`,
      )
    ) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "Cross-origin task requests are not allowed." }));
      return;
    }

    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Tasks are read-only." }));
      return;
    }

    try {
      response.end(JSON.stringify({ tasks: await readTasks(cwd) }));
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
