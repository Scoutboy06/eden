import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importProject, removeProject } from "./import-project";

test("imports existing repositories, canonicalizes worktrees, and preserves global settings", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "eden-import-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(temporary, "config");

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
    expect(saved).toContain(repository);
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
    expect(removed).not.toContain("Example.Project");
    expect(removed).toContain("# Keep preferences");
    expect(removed).toContain("worktree_root: ~/worktrees");
    await git("-C", repository, "rev-parse", "--show-toplevel");
    expect(await importProject({ path: repository, name: "Example.Project" })).toEqual(project);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(temporary, { recursive: true, force: true });
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
