import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createTasksMiddleware } from "./tasks";

type ReadTasks = NonNullable<Parameters<typeof createTasksMiddleware>[1]>;

test("serves provider tasks from the configured checkout without caching", async () => {
  const calls: string[] = [];
  await withServer(
    async (cwd) => {
      calls.push(cwd);
      return [];
    },
    async (url) => {
      const response = await fetch(`${url}/api/tasks`);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ tasks: [] });
      expect(calls).toEqual(["/checkout"]);
    },
  );
});

test("rejects mutations and cross-origin requests without calling the provider", async () => {
  let calls = 0;
  await withServer(
    async () => {
      calls++;
      return [];
    },
    async (url) => {
      const mutation = await fetch(`${url}/api/tasks`, { method: "POST" });
      const crossOrigin = await fetch(`${url}/api/tasks`, {
        headers: { Origin: "https://untrusted.example" },
      });
      const malformedOrigin = await fetch(`${url}/api/tasks`, { headers: { Origin: "not a url" } });
      const unknown = await fetch(`${url}/api/tasks/other`);

      expect(mutation.status).toBe(405);
      expect(mutation.headers.get("allow")).toBe("GET");
      expect(crossOrigin.status).toBe(403);
      expect(malformedOrigin.status).toBe(403);
      expect(unknown.status).toBe(404);
      expect(calls).toBe(0);
    },
  );
});

test("reports provider unavailability rather than returning a misleading empty list", async () => {
  await withServer(
    async () => {
      throw new Error("Could not read Beads tasks.");
    },
    async (url) => {
      const response = await fetch(`${url}/api/tasks`);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Could not read Beads tasks." });
    },
  );
});

async function withServer(readTasks: ReadTasks, run: (url: string) => Promise<void>) {
  const middleware = createTasksMiddleware("/checkout", readTasks);
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
