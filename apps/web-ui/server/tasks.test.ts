import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileConfigService } from "../../../src/modules/config/config.service";
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
      const response = await fetch(`${url}/api/tasks?project=eden`);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ tasks: [] });
      expect(calls).toEqual(["/private/repo"]);
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
      const mutation = await fetch(`${url}/api/tasks?project=eden`, { method: "POST" });
      const crossOrigin = await fetch(`${url}/api/tasks?project=eden`, {
        headers: { Origin: "https://untrusted.example" },
      });
      const malformedOrigin = await fetch(`${url}/api/tasks?project=eden`, {
        headers: { Origin: "not a url" },
      });
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
      const response = await fetch(`${url}/api/tasks?project=eden`);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Could not read Beads tasks." });
    },
  );
});

test("only registered project keys resolve tasks and project metadata omits paths", async () => {
  const calls: string[] = [];
  await withServer(
    async (cwd) => {
      calls.push(cwd);
      return [];
    },
    async (url) => {
      const response = await fetch(`${url}/api/projects`);
      const projects = await response.json();

      expect(projects).toEqual({
        projects: [
          { key: "eden", name: "Eden" },
          { key: "Eden & Co", name: "Encoded" },
        ],
      });
      expect(JSON.stringify(projects)).not.toContain("/private");

      const missingProject = await fetch(`${url}/api/tasks?project=missing`);
      const prototypeProject = await fetch(`${url}/api/tasks?project=toString`);
      const encodedProject = await fetch(`${url}/api/tasks?project=Eden%20%26%20Co`);

      expect(missingProject.status).toBe(404);
      expect(prototypeProject.status).toBe(404);
      expect(encodedProject.status).toBe(200);
      expect(calls).toEqual(["/private/repo"]);
    },
  );
});

test("empty and unreadable project registries are distinguishable", async () => {
  await withServer(
    async () => [],
    async (url) => {
      const response = await fetch(`${url}/api/projects`);
      const projects = await response.json();

      expect(projects).toEqual({ projects: [] });
    },
    async () => ({}),
  );

  const middleware = createTasksMiddleware(
    "/checkout",
    async () => [],
    async () => {
      throw new Error("Invalid global config.");
    },
  );
  const server = createServer((request, response) => void middleware(request, response, () => {}));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Could not load Eden project configuration." });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("serves an empty project list when the loaded config has projects: null", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eden-project-api-"));
  const path = join(directory, "config.yaml");
  await writeFile(path, "projects: null\n");
  const config = createFileConfigService({ pathsLowToHigh: [path] });

  try {
    await withServer(
      async () => [],
      async (url) => {
        const response = await fetch(`${url}/api/projects`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ projects: [] });
      },
      async () => (await config.read()).projects ?? {},
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("documented dev startup serves projects through Bun's runtime", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "eden-web-startup-"));
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );

  const child = spawn(
    "bun",
    ["run", "web:dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { env: { ...process.env, XDG_CONFIG_HOME: configHome }, stdio: "ignore" },
  );

  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/projects`);
        break;
      } catch {
        await Bun.sleep(100);
      }
    }

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ projects: [] });
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(configHome, { recursive: true, force: true });
  }
});

async function withServer(
  readTasks: ReadTasks,
  run: (url: string) => Promise<void>,
  readProjects: () => Promise<Record<string, { name: string; path: string }>> = async () => ({
    eden: { name: "Eden", path: "/private/repo" },
    "Eden & Co": { name: "Encoded", path: "/private/repo" },
  }),
) {
  const middleware = createTasksMiddleware("/checkout", readTasks, readProjects);
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
