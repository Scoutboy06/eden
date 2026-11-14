import type { Octokit } from "@octokit/rest";
import { invalidResponse, ScmError } from "../../modules/pull-requests/errors";
import type {
  PullRequestDiff,
  PullRequestFileDiff,
  PullRequestRef,
} from "../../modules/pull-requests/provider";
import { assertPullRequestIdentity, normalizePullRequest } from "./pull-request-normalization";

type GitHubDiffSnapshot = {
  baseCommit: string;
  headCommit: string;
  changedFiles: number | undefined;
};

export async function readGitHubDiff(
  client: Octokit,
  ref: Extract<PullRequestRef, { provider: "github" }>,
): Promise<PullRequestDiff> {
  const input = parameters(ref);
  const snapshot = await readGitHubDiffSnapshot(client, ref);
  const result = await readGitHubDiffFiles(client, input);
  await confirmGitHubDiffSnapshot(client, input, ref, snapshot);
  if (snapshot.changedFiles !== undefined && result.files.length > snapshot.changedFiles)
    invalidResponse();

  return {
    ref,
    baseCommit: snapshot.baseCommit,
    headCommit: snapshot.headCommit,
    files: result.files,
    completeness: githubDiffCompleteness(result, snapshot.changedFiles),
  };
}

async function readGitHubDiffSnapshot(
  client: Octokit,
  ref: Extract<PullRequestRef, { provider: "github" }>,
): Promise<GitHubDiffSnapshot> {
  const { data } = await client.pulls.get(parameters(ref));
  assertPullRequestIdentity(normalizePullRequest(data), ref);
  const baseCommit = data.base?.sha;
  const headCommit = data.head?.sha;
  const changedFiles = data.changed_files;
  if (
    !baseCommit ||
    !headCommit ||
    (changedFiles !== undefined && (!Number.isSafeInteger(changedFiles) || changedFiles < 0))
  )
    invalidResponse();

  return { baseCommit, headCommit, changedFiles };
}

async function readGitHubDiffFiles(
  client: Octokit,
  input: ReturnType<typeof parameters>,
): Promise<{ files: PullRequestFileDiff[]; reachedLimit: boolean }> {
  const files: PullRequestFileDiff[] = [];
  let reachedLimit = false;
  for await (const { data } of client.paginate.iterator(client.pulls.listFiles, {
    ...input,
    per_page: 100,
  })) {
    files.push(...data.map(normalizeFileDiff));
    if (files.length >= 3000) {
      reachedLimit = true;
      break;
    }
  }

  return { files, reachedLimit };
}

async function confirmGitHubDiffSnapshot(
  client: Octokit,
  input: ReturnType<typeof parameters>,
  ref: Extract<PullRequestRef, { provider: "github" }>,
  snapshot: GitHubDiffSnapshot,
) {
  const { data } = await client.pulls.get(input);
  assertPullRequestIdentity(normalizePullRequest(data), ref);
  if (data.base?.sha !== snapshot.baseCommit || data.head?.sha !== snapshot.headCommit)
    throw new ScmError(
      "SCM_PARTIAL_FAILURE",
      "The PR changed while its file diff was being read. Retry to get a diff for stable commits.",
    );
  if (snapshot.changedFiles !== undefined && data.changed_files !== snapshot.changedFiles)
    throw new ScmError(
      "SCM_PARTIAL_FAILURE",
      "The PR file count changed while its file diff was being read. Retry for a stable result.",
    );
}

function githubDiffCompleteness(
  result: { files: PullRequestFileDiff[]; reachedLimit: boolean },
  changedFiles: number | undefined,
): PullRequestDiff["completeness"] {
  if (changedFiles !== undefined && result.files.length < changedFiles)
    return {
      status: "incomplete",
      reason: `GitHub reported ${changedFiles} changed files but returned ${result.files.length}; file lists are limited to 3,000 files.`,
    };
  if (result.reachedLimit && changedFiles === undefined)
    return {
      status: "incomplete",
      reason: "GitHub file-list completeness cannot be verified at the 3,000-file limit.",
    };

  return { status: "complete" };
}

function normalizeFileDiff(
  data: Awaited<ReturnType<Octokit["pulls"]["listFiles"]>>["data"][number],
): PullRequestFileDiff {
  const hasValidFilename = typeof data.filename === "string" && data.filename.length > 0;
  const hasValidAdditions = Number.isSafeInteger(data.additions) && data.additions >= 0;
  const hasValidDeletions = Number.isSafeInteger(data.deletions) && data.deletions >= 0;
  const hasValidPreviousFilename =
    data.previous_filename === undefined || typeof data.previous_filename === "string";
  if (!hasValidFilename || !hasValidAdditions || !hasValidDeletions || !hasValidPreviousFilename)
    invalidResponse();
  const statuses: Record<string, PullRequestFileDiff["status"]> = {
    added: "added",
    modified: "modified",
    removed: "deleted",
    renamed: "renamed",
    copied: "copied",
    changed: "type-changed",
  };

  const file: PullRequestFileDiff = {
    path: data.filename,
    status: statuses[data.status] ?? "unknown",
    additions: data.additions,
    deletions: data.deletions,
    patch: normalizeFilePatch(data.patch, data.additions, data.deletions),
  };
  if (data.previous_filename) file.previousPath = data.previous_filename;

  return file;
}

function normalizeFilePatch(
  patch: string | undefined,
  additions: number,
  deletions: number,
): PullRequestFileDiff["patch"] {
  if (typeof patch !== "string") return { status: "unavailable", reason: "not-provided" };
  const inspection = inspectFilePatch(patch);
  if (inspection.status === "truncated") return { status: "truncated", text: patch };
  if (inspection.status === "invalid") return { status: "unavailable", reason: "not-provided" };
  const reportedCountsExceedPatch =
    inspection.additions < additions || inspection.deletions < deletions;
  if (reportedCountsExceedPatch) return { status: "truncated", text: patch };
  const patchCountsExceedReported =
    inspection.additions > additions || inspection.deletions > deletions;
  if (patchCountsExceedReported) return { status: "unavailable", reason: "not-provided" };

  return { status: "available", text: patch };
}

type PatchInspection = {
  status: "complete" | "truncated" | "invalid";
  additions: number;
  deletions: number;
};

type PatchScan = {
  hunks: number;
  expectedAdditions: number;
  expectedDeletions: number;
  additions: number;
  deletions: number;
  hunkAdditions: number;
  hunkDeletions: number;
};

function inspectFilePatch(patch: string): PatchInspection {
  const scan: PatchScan = {
    hunks: 0,
    expectedAdditions: 0,
    expectedDeletions: 0,
    additions: 0,
    deletions: 0,
    hunkAdditions: 0,
    hunkDeletions: 0,
  };
  const hasTrailingNewline = patch.endsWith("\n");
  for (const line of patch.split("\n")) {
    const status = consumePatchLine(line, scan, hasTrailingNewline);
    if (status !== undefined)
      return { status, additions: scan.additions, deletions: scan.deletions };
  }
  if (scan.hunks === 0) return { status: "invalid", additions: 0, deletions: 0 };

  return {
    status: compareHunkCounts(
      scan.hunkAdditions,
      scan.hunkDeletions,
      scan.expectedAdditions,
      scan.expectedDeletions,
    ),
    additions: scan.additions,
    deletions: scan.deletions,
  };
}

function consumePatchLine(
  line: string,
  scan: PatchScan,
  hasTrailingNewline: boolean,
): PatchInspection["status"] | undefined {
  const hunk = consumePatchHunk(line, scan);
  if (hunk !== undefined) {
    if (hunk === "complete") return undefined;
    return hunk;
  }
  const kind = patchLineKind(line, scan.hunks > 0, hasTrailingNewline);
  if (kind === "invalid") return "invalid";
  if (kind === "addition") {
    scan.additions++;
    scan.hunkAdditions++;
  } else if (kind === "deletion") {
    scan.deletions++;
    scan.hunkDeletions++;
  } else if (kind === "context") {
    scan.hunkAdditions++;
    scan.hunkDeletions++;
  }

  return undefined;
}

function consumePatchHunk(line: string, scan: PatchScan): PatchInspection["status"] | undefined {
  const range = patchHunkRange(line);
  if (!range) return;
  if (scan.hunks > 0) {
    const status = compareHunkCounts(
      scan.hunkAdditions,
      scan.hunkDeletions,
      scan.expectedAdditions,
      scan.expectedDeletions,
    );
    if (status !== "complete") return status;
  }
  scan.hunks++;
  scan.expectedAdditions = range.additions;
  scan.expectedDeletions = range.deletions;
  scan.hunkAdditions = 0;
  scan.hunkDeletions = 0;

  return "complete";
}

function patchHunkRange(line: string): { additions: number; deletions: number } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
  if (!match) return;

  return { deletions: Number(match[2] ?? 1), additions: Number(match[4] ?? 1) };
}

function patchLineKind(
  line: string,
  inHunk: boolean,
  hasTrailingNewline: boolean,
): "addition" | "deletion" | "context" | "ignored" | "invalid" {
  if ((line === "" && hasTrailingNewline) || line.startsWith("\\ No newline at end of file"))
    return "ignored";
  if (!inHunk) return "invalid";
  if (line.startsWith("+")) return "addition";
  if (line.startsWith("-")) return "deletion";
  if (line.startsWith(" ")) return "context";

  return "invalid";
}

function compareHunkCounts(
  additions: number,
  deletions: number,
  expectedAdditions: number,
  expectedDeletions: number,
): PatchInspection["status"] {
  if (additions === expectedAdditions && deletions === expectedDeletions) return "complete";
  if (additions < expectedAdditions || deletions < expectedDeletions) return "truncated";

  return "invalid";
}

function parameters(ref: Extract<PullRequestRef, { provider: "github" }>) {
  return { owner: ref.owner, repo: ref.repository, pull_number: ref.number };
}
