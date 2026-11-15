import type { IncomingMessage, ServerResponse } from "node:http";
import { createProjectRegistry } from "../../../src/modules/projects/project-registry";
import { registerProject } from "../../../src/modules/projects/project-registration";

let pending = Promise.resolve();
export async function importProject(input: unknown) {
  const operation = pending.then(() => saveProject(input));
  pending = operation.then(
    () => {},
    () => {},
  );
  return operation;
}

export async function removeProject(input: unknown) {
  const operation = pending.then(async () => {
    if (!input || typeof input !== "object" || !("key" in input) || typeof input.key !== "string")
      throw new Error("Specify a project key.");
    await createProjectRegistry().remove(input.key);
  });
  pending = operation.then(
    () => {},
    () => {},
  );
  return operation;
}

async function saveProject(input: unknown) {
  const project = await registerProject(
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as { path: unknown; name?: unknown })
      : { path: undefined },
  );
  return { key: project.key, name: project.name };
}

export async function handleProjectImport(request: IncomingMessage, response: ServerResponse) {
  if (
    !request.headers.origin ||
    request.headers["sec-fetch-site"] === "cross-site" ||
    !request.headers["content-type"]?.startsWith("application/json")
  ) {
    response.statusCode = 403;
    response.end(JSON.stringify({ error: "Same-origin JSON requests are required." }));
    return;
  }
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 8192) throw new Error("Request is too large.");
    }
    const input: unknown = JSON.parse(body);
    if (request.method === "DELETE") {
      await removeProject(input);
      response.end(JSON.stringify({ removed: true }));
    } else {
      const project = await importProject(input);
      response.statusCode = 201;
      response.end(JSON.stringify({ project }));
    }
  } catch (error) {
    response.statusCode = 400;
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Could not update projects.",
      }),
    );
  }
}
