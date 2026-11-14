import type { GitFileChange, GitHead, GitRepositoryStatus } from "./git.module";

export function parseRepositoryStatus(output: string): GitRepositoryStatus {
  const records = output.split("\0");
  const head = parseHead(records);
  const changes = parseChanges(records);
  const upstreamRecord = records.find((record) => record.startsWith("# branch.upstream "));
  const aheadBehind = records.find((record) => record.startsWith("# branch.ab "));
  const counts = aheadBehind?.match(/^# branch\.ab \+(\d+) -(\d+)$/);
  const upstream = upstreamRecord
    ? {
        name: upstreamRecord.slice("# branch.upstream ".length),
        ahead: counts ? Number(counts[1]) : null,
        behind: counts ? Number(counts[2]) : null,
      }
    : null;

  return { head, ...changes, upstream };
}

function addChange(
  change: GitFileChange,
  staged: GitFileChange[],
  unstaged: GitFileChange[],
): void {
  if (change.indexStatus !== ".") staged.push(change);
  if (change.worktreeStatus !== ".") unstaged.push(change);
}

function parseHead(records: string[]): GitHead {
  const branch = records.find((record) => record.startsWith("# branch.head "))?.slice(14);
  const oid = records.find((record) => record.startsWith("# branch.oid "))?.slice(13);

  if (branch === "(detached)") return { kind: "detached", commit: oid ?? "" };
  if (branch === undefined || oid === undefined || oid === "(initial)") {
    return { kind: "unborn", branch: branch ?? "" };
  }

  return { kind: "branch", name: branch, commit: oid };
}

function parseChanges(records: string[]): Omit<GitRepositoryStatus, "head" | "upstream"> {
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: string[] = [];
  const conflicts: GitFileChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;

    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const isRename = record.startsWith("2 ");
      let originalPath: string | undefined;

      if (isRename) {
        index += 1;
        originalPath = records[index];
      }

      const change = parseTrackedChange(record, originalPath);
      addChange(change, staged, unstaged);
    } else if (record.startsWith("u ")) {
      conflicts.push(parseConflict(record));
    } else if (record.startsWith("? ")) {
      untracked.push(record.slice(2));
    }
  }

  return { staged, unstaged, untracked, conflicts };
}

function parseTrackedChange(record: string, originalPath?: string): GitFileChange {
  const fields = record.split(" ");
  const isRename = record.startsWith("2 ");
  const pathFieldIndex = isRename ? 9 : 8;
  const path = fields.slice(pathFieldIndex).join(" ");
  const change: GitFileChange = {
    path,
    indexStatus: fields[1]![0]!,
    worktreeStatus: fields[1]![1]!,
  };

  if (originalPath !== undefined) change.originalPath = originalPath;

  return change;
}

function parseConflict(record: string): GitFileChange {
  const fields = record.split(" ");

  return {
    path: fields.slice(10).join(" "),
    indexStatus: fields[1]![0]!,
    worktreeStatus: fields[1]![1]!,
  };
}
