import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../../src/modules/fs/tests/support/temporary-directory";
import { listRegisteredProjects } from "../../../src/modules/projects/project-registry";

import { importProject, removeProject } from "./import-project";
import { createTasksMiddleware } from "./tasks";

test("imports existing repositories, canonicalizes worktrees, and preserves global settings", async () => {
  await using directory = await createTemporaryDirectory();
  const temporary = realpathSync.native(directory.path);
  const previous = process.env.XDG_CONFIG_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = join(temporary, "config");
  process.env.XDG_STATE_HOME = join(temporary, "state");

  try {
    const repository = join(temporary, "repo");
    await mkdir(repository);
    await git("init", repository);
    const config = join(temporary, "config", "eden", "config.yaml");
    await mkdir(join(temporary, "config", "eden"), { recursive: true });
    await writeFile(config, "# Keep preferences\nworktree_root: ~/worktrees\nprojects: null\n");

    await expect(importProject({ path: temporary })).rejects.toThrow("Git");
    await expect(importProject({ path: "relative" })).rejects.toThrow("absolute");
    const project = await importProject({ path: repository, name: "Example.Project" });

    expect(project).toEqual({ key: "Example.Project", name: "Example.Project" });
    const saved = await readFile(config, "utf8");
    expect(saved).toContain("# Keep preferences");
    expect(saved).toContain("worktree_root: ~/worktrees");
    expect(saved).toContain("projects: null");
    expect(await listRegisteredProjects()).toEqual([
      { key: project.key, name: project.name, path: repository },
    ]);
    await expect(importProject({ path: repository })).rejects.toThrow("already imported");

    await git(
      "-C",
      repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    );
    const worktree = join(temporary, "worktree");
    await git("-C", repository, "worktree", "add", "-b", "example", worktree);
    await expect(importProject({ path: worktree })).rejects.toThrow("already imported");
    await expect(removeProject({ key: "missing" })).rejects.toThrow("not found");
    await expect(removeProject({ key: "__proto__" })).rejects.toThrow("not found");
    await removeProject({ key: project.key });
    const removed = await readFile(config, "utf8");
    expect(removed).toContain("# Keep preferences");
    expect(removed).toContain("worktree_root: ~/worktrees");
    expect(await listRegisteredProjects()).toEqual([]);
    await git("-C", repository, "rev-parse", "--show-toplevel");
    expect(await importProject({ path: repository, name: "Example.Project" })).toEqual(project);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
  }
});

test("web project HTTP add, list, and remove share the persistent registry", async () => {
  await using directory = await createTemporaryDirectory();
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = join(directory.path, "config");
  process.env.XDG_STATE_HOME = join(directory.path, "state");
  const repository = join(directory.path, "repository");
  await mkdir(repository);
  await git("init", repository);
  const middleware = createTasksMiddleware(directory.path, async () => []);
  const server = createServer(
    (request, response) =>
      void middleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const directories = `${url}/api/projects/directories?path=~/`;
    const browserHeaders = { "X-Eden-Directory-Browser": "1" };
    expect((await fetch(directories)).status).toBe(403);
    expect(
      (
        await fetch(directories, {
          headers: { ...browserHeaders, Origin: "https://other.example" },
        })
      ).status,
    ).toBe(403);
    const browsed = await fetch(directories, {
      headers: { ...browserHeaders, "Sec-Fetch-Site": "same-origin" },
    });
    expect(browsed.status).toBe(200);
    expect(browsed.headers.get("cache-control")).toBe("no-store");
    expect(await browsed.json()).toMatchObject({ directory: "~/", parent: null });

    const added = await fetch(`${url}/api/projects`, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ path: repository, name: "Via API" }),
    });
    const addedBody = await added.text();
    if (added.status !== 201) throw new Error(addedBody);
    expect(added.status).toBe(201);
    const project = (JSON.parse(addedBody) as { project: { key: string; name: string } }).project;
    expect(project).toEqual({ key: "Via-API", name: "Via API" });

    const listed = await fetch(`${url}/api/projects`);
    expect(await listed.json()).toEqual({ projects: [{ key: "Via-API", name: "Via API" }] });
    const removed = await fetch(`${url}/api/projects`, {
      method: "DELETE",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ key: project.key }),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect(await (await fetch(`${url}/api/projects`)).json()).toEqual({ projects: [] });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
  }
});

async function git(...args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    stdout: "ignore",
    stderr: "pipe",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
  const error = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(error);
}
