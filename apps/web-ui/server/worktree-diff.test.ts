import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { lstat, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorktreeDiffMiddleware, readWorktreeDiff } from "./worktree-diff";

test("scopes changes to the selected worktree and handles statuses and fallback files", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "eden-worktree-diff-"));
  const repository = join(scratch, "checkout");
  const marker = join(scratch, "textconv-ran");
  await mkdir(repository);
  await initializeRepository(repository, scratch);
  await writeFile(join(repository, "modified.txt"), "staged contents\n");
  await runGit(repository, ["add", "modified.txt"]);
  await writeFile(join(repository, "modified.txt"), "working contents\n");
  await writeFile(join(repository, "staged.txt"), "staged only\n");
  await runGit(repository, ["add", "staged.txt"]);
  await writeFile(join(repository, "new-staged.txt"), "staged addition\n");
  await runGit(repository, ["add", "new-staged.txt"]);
  await unlink(join(repository, "deleted.txt"));
  await runGit(repository, ["mv", "rename-old.txt", "renamed.txt"]);
  await writeFile(join(repository, "odd\nname.txt"), "unusual filename\n");
  await writeFile(join(repository, "binary.dat"), new Uint8Array([0, 1, 2, 255]));
  await writeFile(join(repository, "large.txt"), "x".repeat(256 * 1024 + 1));
  await symlink("/etc/passwd", join(repository, "outside-link"));
  await runGit(repository, ["config", "diff.txt.textconv", `touch ${marker}`]);

  try {
    const worktreeDiff = await readWorktreeDiff(repository);
    const files = new Map(worktreeDiff.files.map((file) => [file.path, file]));

    expect(worktreeDiff.base).toBe("HEAD");
    expect(files.get("modified.txt")).toMatchObject({
      change: "modified",
      oldContents: "before\n",
      newContents: "working contents\n",
    });
    expect(files.get("staged.txt")).toMatchObject({
      oldContents: "before\n",
      newContents: "staged only\n",
    });
    expect(files.get("new-staged.txt")).toMatchObject({
      change: "added",
      oldContents: null,
      newContents: "staged addition\n",
    });
    expect(files.get("deleted.txt")).toMatchObject({ change: "deleted", newContents: null });
    expect(files.get("renamed.txt")).toMatchObject({
      change: "renamed",
      previousPath: "rename-old.txt",
      oldContents: "rename me\n",
      newContents: "rename me\n",
    });
    expect(files.get("odd\nname.txt")?.newContents).toBe("unusual filename\n");
    expect(files.get("binary.dat")?.fallback).toBe("binary");
    expect(files.get("large.txt")?.fallback).toBe("too-large");
    expect(files.get("outside-link")?.fallback).toBe("unavailable");
    expect(await exists(marker)).toBe(false);

    await withServer(
      createWorktreeDiffMiddleware({
        readProjects: async () => ({ fixture: { name: "Fixture", path: scratch } }),
        worktrees: async () => [{ path: repository, branch: "main" }],
      }),
      async (url) => {
        const query = new URLSearchParams({
          project: "fixture",
          worktree: "checkout",
          branch: "main",
          path: "/etc/passwd",
        });
        const response = await fetch(`${url}/api/worktree-diff?${query}`);
        const body = (await response.json()) as { files: { path: string }[] };

        expect(response.status).toBe(200);
        expect(body.files.map(({ path }) => path)).toContain("odd\nname.txt");
        expect(body.files.map(({ path }) => path)).not.toContain("/etc/passwd");
        expect(
          (await fetch(`${url}/api/worktree-diff?project=missing&worktree=checkout&branch=main`))
            .status,
        ).toBe(404);
        expect(
          (
            await fetch(`${url}/api/worktree-diff?${query}`, {
              headers: { Origin: "https://attacker.example" },
            })
          ).status,
        ).toBe(403);
        expect((await fetch(`${url}/api/worktree-diff?${query}`, { method: "POST" })).status).toBe(
          405,
        );
      },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("compares an unborn repository against an empty tree and reports a clean tree", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "eden-worktree-diff-unborn-"));
  const repository = join(scratch, "unborn");
  await mkdir(repository);

  try {
    await runGit(repository, ["init", "--initial-branch=main"]);
    await writeFile(join(repository, "first.txt"), "first commit content\n");

    const initial = await readWorktreeDiff(repository);
    expect(initial.base).toBe("empty tree");
    expect(initial.files).toMatchObject([
      {
        path: "first.txt",
        change: "added",
        oldContents: null,
        newContents: "first commit content\n",
      },
    ]);

    await runGit(repository, ["config", "user.name", "Eden test"]);
    await runGit(repository, ["config", "user.email", "eden@example.invalid"]);
    await runGit(repository, ["add", "first.txt"]);
    await runGit(repository, ["commit", "--quiet", "-m", "initial"]);
    expect(await readWorktreeDiff(repository)).toMatchObject({
      base: "HEAD",
      files: [],
      omittedFileCount: 0,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

async function initializeRepository(repository: string, config: string) {
  await runGit(repository, ["init", "--initial-branch=main"], config);
  await runGit(repository, ["config", "user.name", "Eden test"], config);
  await runGit(repository, ["config", "user.email", "eden@example.invalid"], config);
  await Promise.all([
    writeFile(join(repository, "modified.txt"), "before\n"),
    writeFile(join(repository, "staged.txt"), "before\n"),
    writeFile(join(repository, "deleted.txt"), "before\n"),
    writeFile(join(repository, "rename-old.txt"), "rename me\n"),
  ]);
  await runGit(repository, ["add", "."], config);
  await runGit(repository, ["commit", "--quiet", "-m", "initial"], config);
}

async function runGit(repository: string, args: string[], config = repository) {
  const git = Bun.which("git");
  if (!git) throw new Error("Git is required for worktree diff tests.");
  const child = spawn(git, ["-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(config, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [code] = await new Promise<[number | null]>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve([exitCode]));
  });
  if (code !== 0) throw new Error(stderr || `git ${args[0]} failed`);
  return stdout;
}

async function withServer(
  middleware: ReturnType<typeof createWorktreeDiffMiddleware>,
  run: (url: string) => Promise<void>,
) {
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

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
