import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { runGit } from "../../../src/external/simple-git/git";
import { GitModule } from "../../../src/modules/git/git.module";
import type { WorktreeDiff, WorktreeDiffFile } from "../shared/worktree-diff";
import { requestUrl } from "./request-url";
import { resolveWorktree } from "./terminals";

const fileLimit = 100;
const contentLimit = 256 * 1024;

export type WorktreeDiffDependencies = {
  readProjects: () => Promise<Record<string, { name: string; path: string }>>;
  worktrees?: typeof GitModule.worktrees;
};

type StatusEntry = {
  path: string;
  previousPath?: string;
  status: string;
};

type TreeBlob = {
  object: string;
  size: number;
};

export function createWorktreeDiffMiddleware(dependencies: WorktreeDiffDependencies) {
  return async (
    request: IncomingMessage & { originalUrl?: string },
    response: ServerResponse,
    next: () => void,
  ) => {
    const url = requestUrl(request);
    if (url.pathname !== "/api/worktree-diff") return next();

    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (!sameOrigin(request))
      return respond(response, 403, { error: "Cross-origin requests are not allowed." });
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return respond(response, 405, { error: "This endpoint is read-only." });
    }

    try {
      const scope = requestedScope(url);
      const worktree = await resolveWorktree(scope, dependencies);
      const path = url.searchParams.get("file");
      if (path !== null) {
        const file = await readWorktreeDiffFile(worktree, path);
        return file
          ? respond(response, 200, file)
          : respond(response, 404, { error: "Changed file not found." });
      }
      const diff = await readWorktreeDiff(worktree);
      return respond(response, 200, diff);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = message.includes("not found") ? 404 : 400;
      return respond(response, status, {
        error:
          status === 404 ? "Project or worktree not found." : "Could not read worktree changes.",
      });
    }
  };
}

export async function readWorktreeDiff(worktree: string): Promise<WorktreeDiff> {
  const status = await runGit(worktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const entries = parseStatus(status);
  const head = await resolveHead(worktree);
  const uniqueEntries = deduplicateEntries(entries);
  const selected = uniqueEntries.slice(0, fileLimit);
  const files = selected.map(describeDiffFile);

  return {
    files,
    base: head ? "HEAD" : "empty tree",
    omittedFileCount: Math.max(0, uniqueEntries.length - selected.length),
  };
}

export async function readWorktreeDiffFile(
  worktree: string,
  path: string,
): Promise<WorktreeDiffFile | null> {
  if (!safeGitPath(path)) return null;
  const status = await runGit(worktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const selected = deduplicateEntries(parseStatus(status)).slice(0, fileLimit);
  const entry = selected.find((candidate) => candidate.path === path);
  if (!entry) return null;
  const blob = (await resolveHead(worktree))
    ? await readTreeBlob(worktree, entry.previousPath ?? path)
    : undefined;
  const tree = new Map<string, TreeBlob>();
  if (blob) tree.set(entry.previousPath ?? path, blob);
  return { ...(await readDiffFile(worktree, entry, tree)), contentLoaded: true };
}

function describeDiffFile(entry: StatusEntry): WorktreeDiffFile {
  const change =
    entry.status === "R" || entry.previousPath
      ? "renamed"
      : entry.status.includes("A")
        ? "added"
        : entry.status === "D"
          ? "deleted"
          : "modified";
  return {
    path: entry.path,
    ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
    change,
    oldContents: null,
    newContents: null,
  };
}

async function readDiffFile(
  worktree: string,
  entry: StatusEntry,
  tree: Map<string, TreeBlob>,
): Promise<WorktreeDiffFile> {
  const previousPath = entry.previousPath ?? entry.path;
  const oldBlob = tree.get(previousPath);
  const file: WorktreeDiffFile = {
    path: entry.path,
    ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
    change: changeKind(entry, oldBlob !== undefined),
    oldContents: null,
    newContents: null,
  };

  if (entry.status === "U") return { ...file, fallback: "conflict" };
  const contents = await readFileContents(worktree, entry, oldBlob);
  if (typeof contents === "string") return { ...file, fallback: contents };
  return {
    ...file,
    oldContents: contents.oldContents,
    newContents: contents.newContents,
  };
}

function changeKind(entry: StatusEntry, existsInHead: boolean): WorktreeDiffFile["change"] {
  if (entry.status === "R" || entry.previousPath) return "renamed";
  if (!existsInHead) return "added";
  return entry.status === "D" ? "deleted" : "modified";
}

async function readFileContents(
  worktree: string,
  entry: StatusEntry,
  oldBlob: TreeBlob | undefined,
): Promise<
  | { oldContents: string | null; newContents: string | null }
  | Exclude<WorktreeDiffFile["fallback"], undefined>
> {
  if (oldBlob && oldBlob.size > contentLimit) return "too-large";
  const oldContents = oldBlob ? await readBlob(worktree, oldBlob) : null;
  const newContents = entry.status === "D" ? null : await readWorktreeFile(worktree, entry.path);
  const fallback = contentFallback(oldContents, newContents);
  return fallback ?? { oldContents, newContents };
}

function contentFallback(
  oldContents: string | "binary" | "too-large" | "unavailable" | null,
  newContents: string | "binary" | "too-large" | "unavailable" | null,
): Exclude<WorktreeDiffFile["fallback"], undefined> | undefined {
  if (oldContents === "binary" || newContents === "binary") return "binary";
  if (oldContents === "unavailable" || newContents === "unavailable") return "unavailable";
  if (oldContents === "too-large" || newContents === "too-large") return "too-large";
  return undefined;
}

async function readBlob(
  worktree: string,
  blob: TreeBlob,
): Promise<string | "binary" | "too-large"> {
  if (blob.size > contentLimit) return "too-large";
  const contents = await runGit(worktree, ["cat-file", "blob", blob.object]);
  if (contents.includes("\0") || Buffer.byteLength(contents) !== blob.size) return "binary";
  return contents;
}

async function readWorktreeFile(
  worktree: string,
  path: string,
): Promise<string | "binary" | "too-large" | "unavailable"> {
  const absolute = safeWorktreePath(worktree, path);
  if (!absolute) return "unavailable";

  try {
    const resolved = await realpath(absolute);
    if (!isWithin(worktree, resolved)) return "unavailable";
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      const contents = await readlink(absolute);
      return Buffer.byteLength(contents) > contentLimit ? "too-large" : contents;
    }
    if (!metadata.isFile()) return "unavailable";
    if (metadata.size > contentLimit) return "too-large";
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return "unavailable";
      if (opened.size > contentLimit) return "too-large";
      const contents = await readBounded(handle);
      if (contents === null) return "too-large";
      if (contents.includes(0)) return "binary";
      const text = contents.toString("utf8");
      return Buffer.byteLength(text) === contents.byteLength ? text : "binary";
    } finally {
      await handle.close();
    }
  } catch {
    return "unavailable";
  }
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  while (size <= contentLimit) {
    const chunk = Buffer.alloc(Math.min(16 * 1024, contentLimit + 1 - size));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks, size);
    chunks.push(chunk.subarray(0, bytesRead));
    size += bytesRead;
  }
  return null;
}

async function readTreeBlob(worktree: string, path: string): Promise<TreeBlob | undefined> {
  const output = await runGit(worktree, [
    "--literal-pathspecs",
    "ls-tree",
    "-l",
    "-z",
    "HEAD",
    "--",
    path,
  ]);
  const record = output.split("\0").find(Boolean);
  const separator = record?.indexOf("\t") ?? -1;
  if (!record || separator < 0) return undefined;
  const [, type, object, sizeText] = record.slice(0, separator).trim().split(/\s+/);
  const size = Number(sizeText);
  return type === "blob" &&
    object &&
    /^[0-9a-f]{40,64}$/i.test(object) &&
    Number.isSafeInteger(size) &&
    safeWorktreePath(worktree, path)
    ? { object, size }
    : undefined;
}

async function resolveHead(worktree: string): Promise<string | null> {
  try {
    const head = await runGit(worktree, ["rev-parse", "--verify", "HEAD"]);
    return /^[0-9a-f]{40,64}$/i.test(head.trim()) ? head.trim() : null;
  } catch {
    return null;
  }
}

function parseStatus(output: string): StatusEntry[] {
  const records = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const parsed = parseStatusRecord(record);
    if (!parsed) continue;
    if (isRenameStatus(parsed.status)) {
      const previousPath = records[++index];
      if (previousPath && safeGitPath(previousPath))
        entries.push({ ...parsed, previousPath, status: "R" });
      continue;
    }
    entries.push({ ...parsed, status: normalizedStatus(parsed.status) });
  }
  return entries;
}

function parseStatusRecord(record: string): Pick<StatusEntry, "path" | "status"> | undefined {
  if (record.length < 4) return undefined;
  const path = record.slice(3);
  return safeGitPath(path) ? { path, status: record.slice(0, 2) } : undefined;
}

function isRenameStatus(status: string): boolean {
  return status.includes("R") || status.includes("C");
}

function normalizedStatus(status: string): string {
  if (status === "??") return "A";
  if (status.includes("U")) return "U";
  if (status.includes("D") && status[1] !== "M" && status[1] !== "A") return "D";
  return status;
}

function deduplicateEntries(entries: StatusEntry[]): StatusEntry[] {
  const byPath = new Map<string, StatusEntry>();
  for (const entry of entries) byPath.set(entry.path, entry);
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function requestedScope(url: URL) {
  const project = url.searchParams.get("project");
  const worktree = url.searchParams.get("worktree");
  const branch = url.searchParams.get("branch");
  if (!project || !worktree || branch === null) throw new Error("Project or worktree not found.");
  return { project, worktree, branch: branch || null };
}

function safeGitPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !isAbsolute(path) &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function safeWorktreePath(worktree: string, path: string): string | null {
  if (!safeGitPath(path)) return null;
  const absolute = resolve(worktree, path);
  return isWithin(worktree, absolute) ? absolute : null;
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return (
    origin === undefined ||
    origin === `http://${request.headers.host}` ||
    origin === `https://${request.headers.host}`
  );
}

function respond(response: ServerResponse, status: number, body: object): void {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}
