import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { IGitApi } from "azure-devops-node-api/GitApi";
import {
  GitVersionType,
  VersionControlChangeType,
  type GitPullRequestChange,
} from "azure-devops-node-api/interfaces/GitInterfaces";
import type { PullRequestFileDiff } from "../../modules/pull-requests/provider";
import { invalidResponse } from "../../modules/pull-requests/errors";
import type { AzureDiffSnapshot } from "./diff";

export type AzureItemContentClient = Pick<IGitApi, "getItemContent">;
const maxContentBytes = 1_000_000;

export async function readAzureFileDiff(
  git: AzureItemContentClient,
  snapshot: AzureDiffSnapshot,
  change: GitPullRequestChange,
): Promise<PullRequestFileDiff> {
  const location = fileLocation(change);
  const empty = { bytes: Buffer.alloc(0) };
  const oldContent =
    location.status === "added"
      ? empty
      : await readContent(
          git,
          snapshot,
          location.previousPath ?? location.path,
          snapshot.commonCommit,
        );
  const newContent =
    location.status === "deleted"
      ? empty
      : await readContent(git, snapshot, location.path, snapshot.sourceCommit);

  return { ...location, ...(await compareContent(oldContent, newContent)) };
}

function fileLocation(change: GitPullRequestChange) {
  const path = change.item?.path?.replace(/^\/+/, "");
  const previousPath = change.sourceServerItem?.replace(/^\/+/, "") ?? path;
  if (!path || !previousPath || path.includes("\0") || previousPath.includes("\0"))
    invalidResponse();
  const status = changeType(change);
  return {
    path,
    status,
    ...(status === "renamed" || previousPath !== path ? { previousPath } : {}),
  };
}

async function compareContent(
  oldContent: { bytes: Buffer } | { unavailable: "binary" | "too-large" },
  newContent: { bytes: Buffer } | { unavailable: "binary" | "too-large" },
): Promise<Pick<PullRequestFileDiff, "additions" | "deletions" | "patch">> {
  if ("unavailable" in oldContent) return unavailablePatch(oldContent.unavailable);
  if ("unavailable" in newContent) return unavailablePatch(newContent.unavailable);
  return makePatch(oldContent.bytes, newContent.bytes);
}

function unavailablePatch(
  reason: "binary" | "too-large",
): Pick<PullRequestFileDiff, "additions" | "deletions" | "patch"> {
  return { additions: 0, deletions: 0, patch: { status: "unavailable", reason } };
}

async function readContent(
  git: AzureItemContentClient,
  snapshot: AzureDiffSnapshot,
  path: string,
  commit: string,
): Promise<{ bytes: Buffer } | { unavailable: "binary" | "too-large" }> {
  const stream = await git.getItemContent(
    snapshot.repositoryId,
    path,
    snapshot.projectId,
    undefined,
    undefined,
    false,
    false,
    false,
    {
      versionType: GitVersionType.Commit,
      version: commit,
    },
  );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxContentBytes) return { unavailable: "too-large" };
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.includes(0)) return { unavailable: "binary" };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { unavailable: "binary" };
  }
  return { bytes };
}

async function makePatch(oldBytes: Buffer, newBytes: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "eden-azure-diff-"));
  try {
    const oldFile = join(directory, "old");
    const newFile = join(directory, "new");
    await writeFile(oldFile, oldBytes);
    await writeFile(newFile, newBytes);
    const result = await gitDiff(oldFile, newFile);
    const hunkStart = result.search(/^@@ /m);
    const text = hunkStart < 0 ? "" : result.slice(hunkStart);
    const lines = text.split("\n");
    const additions = lines.filter((line) => line.startsWith("+")).length;
    const deletions = lines.filter((line) => line.startsWith("-")).length;
    return { additions, deletions, patch: { status: "available" as const, text } };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function gitDiff(oldFile: string, newFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [
      "-c",
      "core.autocrlf=false",
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--text",
      "--unified=3",
      "--",
      oldFile,
      newFile,
    ]);
    child.stdin.end();
    child.stderr.resume();
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`git diff failed with exit code ${code}`));
    });
  });
}

function changeType(change: GitPullRequestChange): PullRequestFileDiff["status"] {
  const type = change.changeType ?? VersionControlChangeType.None;
  if (type & VersionControlChangeType.Rename) return "renamed";
  if (type & VersionControlChangeType.Add) return "added";
  if (type & VersionControlChangeType.Delete) return "deleted";
  if (type & VersionControlChangeType.Edit) return "modified";
  return "unknown";
}
