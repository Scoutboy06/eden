import type { IncomingMessage, ServerResponse } from "node:http";

import {
  getBeadsTask,
  getBeadsStatuses,
  updateBeadsTask,
} from "../../../src/external/beads/task-detail";

export const taskDetails = {
  get: getBeadsTask,
  statuses: getBeadsStatuses,
  update: updateBeadsTask,
};

export async function handleTaskDetail(
  request: IncomingMessage,
  response: ServerResponse,
  cwd: string,
  id: string,
  provider = taskDetails,
) {
  try {
    if (request.method === "GET") {
      const [task, statuses] = await Promise.all([provider.get(cwd, id), provider.statuses(cwd)]);
      response.end(JSON.stringify({ task, statuses }));
      return;
    }
    if (request.method !== "PATCH") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, PATCH");
      response.end(JSON.stringify({ error: "Method not allowed." }));
      return;
    }
    if (
      !request.headers.origin ||
      request.headers["sec-fetch-site"] === "cross-site" ||
      request.headers["content-type"]?.split(";")[0] !== "application/json"
    ) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "Same-origin JSON requests are required." }));
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 512_000) throw new Error("Request is too large.");
    }
    let patch: unknown;
    try {
      patch = JSON.parse(body);
    } catch {
      throw new Error("Invalid JSON request.");
    }
    const task = await provider.update(cwd, id, patch);
    response.end(JSON.stringify({ task }));
  } catch (error) {
    response.statusCode = request.method === "GET" ? 503 : 400;
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Could not load or save task.",
      }),
    );
  }
}
