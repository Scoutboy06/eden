import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createTasksMiddleware } from "./tasks";

const task = {
  id: "eden-1",
  title: "Title",
  description: "Body",
  issue_type: "task",
  status: "open",
  priority: 2 as const,
};
const statuses = ["open", "in_progress"];
type TaskServer = {
  origin: string;
  url: string;
  reads: unknown[];
  writes: unknown[];
};

test("task details and edits use the selected project's checkout", async () => {
  await withTaskServer(async ({ origin, url, reads, writes }) => {
    const changes = { title: "Edited" };
    const request = {
      method: "PATCH",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    };

    const details = await fetch(url);
    const detailBody = await details.json();
    const saved = await fetch(url, request);
    const savedBody = await saved.json();

    expect(details.status).toBe(200);
    expect(detailBody).toEqual({ task, statuses });
    expect(reads).toEqual([["/configured", "eden-1"]]);
    expect(saved.status).toBe(200);
    expect(savedBody).toEqual({ task: { ...task, title: "Edited" } });
    expect(writes).toEqual([["/configured", "eden-1", changes]]);
  });
});

test("unsafe or malformed update requests never reach the provider", async () => {
  await withTaskServer(async ({ origin, url, writes }) => {
    const changes = JSON.stringify({ title: "Edited" });
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const foreignHeaders = { ...headers, Origin: "https://evil.example" };
    const unknownProject = `${origin}/api/tasks/eden-1?project=missing`;

    const [withoutOrigin, crossOrigin, wrongProject, invalidJson, unsupportedMethod] =
      await Promise.all([
        fetch(url, { method: "PATCH", body: changes }),
        fetch(url, { method: "PATCH", headers: foreignHeaders, body: changes }),
        fetch(unknownProject, { method: "PATCH", headers, body: changes }),
        fetch(url, { method: "PATCH", headers, body: "{" }),
        fetch(url, { method: "DELETE", headers }),
      ]);

    expect(withoutOrigin.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(wrongProject.status).toBe(404);
    expect(invalidJson.status).toBe(400);
    expect(unsupportedMethod.status).toBe(405);
    expect(writes).toEqual([]);
  });
});

async function withTaskServer(run: (server: TaskServer) => Promise<void>) {
  const reads: unknown[] = [];
  const writes: unknown[] = [];
  const projects = { eden: { name: "Eden", path: "/configured" } };
  const provider = {
    get: async (cwd: string, id: string) => {
      reads.push([cwd, id]);
      return task;
    },
    statuses: async () => statuses,
    update: async (cwd: string, id: string, changes: unknown) => {
      writes.push([cwd, id, changes]);
      return { ...task, title: "Edited" };
    },
  };
  const middleware = createTasksMiddleware(
    "/unused",
    async () => [],
    async () => projects,
    provider,
  );
  const server = createServer(
    (request, response) =>
      void middleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/api/tasks/eden-1?project=eden`;

  try {
    await run({ origin, url, reads, writes });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
