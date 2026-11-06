import { basename } from "node:path";

export type GitHead =
  | { kind: "branch"; name: string; commit: string }
  | { kind: "detached"; commit: string }
  | { kind: "unborn"; branch: string };

export type GitFileChange = {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
};

export type GitRepositoryStatus = {
  head: GitHead;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
  conflicts: GitFileChange[];
  upstream: { name: string; ahead: number | null; behind: number | null } | null;
};

export type GitLocalBranch = {
  name: string;
  commit: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  worktrees: string[];
};

export class GitModule {
  static async execute(cwd: string, args: readonly string[]): Promise<string> {
    return (await GitModule.executeRaw(cwd, args)).trim();
  }

  static async status(cwd: string): Promise<GitRepositoryStatus> {
    const output = await GitModule.executeRaw(cwd, [
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
      "--ahead-behind",
      "--untracked-files=all",
      "-z",
    ]);
    return parseRepositoryStatus(output);
  }

  static async localBranches(cwd: string): Promise<GitLocalBranch[]> {
    await GitModule.executeRaw(cwd, ["rev-parse", "--git-dir"]);
    const [listing, worktreeOutput] = await Promise.all([
      GitModule.executeRaw(cwd, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(upstream)",
        "refs/heads/",
      ]),
      GitModule.executeRaw(cwd, ["worktree", "list", "--porcelain", "-z"]),
    ]);
    const worktrees = new Map<string, string[]>();
    let path = "";
    for (const record of worktreeOutput.split("\0")) {
      if (record.startsWith("worktree ")) path = record.slice("worktree ".length);
      else if (record.startsWith("branch ")) {
        const ref = record.slice("branch ".length);
        worktrees.set(ref, [...(worktrees.get(ref) ?? []), path]);
      }
    }

    return Promise.all(
      listing
        .split("\n")
        .filter(Boolean)
        .map(async (line) => {
          const [fullRef = "", commit = "", upstreamRef = ""] = line.split("\0");
          const name = fullRef.slice("refs/heads/".length);
          const upstream = upstreamRef ? displayRef(upstreamRef) : null;
          const counts = upstreamRef ? await GitModule.divergence(cwd, fullRef, upstreamRef) : null;
          return {
            name,
            commit,
            upstream,
            ahead: counts?.ahead ?? null,
            behind: counts?.behind ?? null,
            worktrees: worktrees.get(fullRef) ?? [],
          };
        }),
    );
  }

  private static async executeRaw(cwd: string, args: readonly string[]): Promise<string> {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args[0]} failed (${exitCode})`);

    return stdout;
  }

  private static async divergence(
    cwd: string,
    branchRef: string,
    upstreamRef: string,
  ): Promise<{ ahead: number; behind: number } | null> {
    try {
      const output = await GitModule.executeRaw(cwd, [
        "rev-list",
        "--left-right",
        "--count",
        "--end-of-options",
        `${branchRef}...${upstreamRef}`,
      ]);
      const counts = output.trim().match(/^(\d+)\s+(\d+)$/);
      return counts ? { ahead: Number(counts[1]), behind: Number(counts[2]) } : null;
    } catch {
      return null;
    }
  }

  static async repositoryName(cwd: string): Promise<string> {
    const listing = await GitModule.execute(cwd, ["worktree", "list", "--porcelain", "-z"]);
    const mainPath = listing.split("\0")[0]?.slice("worktree ".length);

    if (
      !mainPath ||
      (await GitModule.execute(cwd, ["rev-parse", "--is-bare-repository"])) === "true"
    ) {
      throw new Error("Worktree creation requires a non-bare Git repository");
    }

    return basename(mainPath);
  }

  static resolveCommit(cwd: string, ref = "HEAD"): Promise<string> {
    return GitModule.execute(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  }

  static async createWorktree(
    cwd: string,
    input: { branch: string; path: string; base: string },
  ): Promise<void> {
    await GitModule.execute(cwd, [
      "worktree",
      "add",
      "-b",
      input.branch,
      "--",
      input.path,
      input.base,
    ]);
  }
}

function addChange(
  change: GitFileChange,
  staged: GitFileChange[],
  unstaged: GitFileChange[],
): void {
  if (change.indexStatus !== ".") staged.push(change);
  if (change.worktreeStatus !== ".") unstaged.push(change);
}

function parseRepositoryStatus(output: string): GitRepositoryStatus {
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
      const change = parseTrackedChange(
        record,
        record.startsWith("2 ") ? records[++index] : undefined,
      );
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
  const renamed = record.startsWith("2 ");
  const change: GitFileChange = {
    path: fields.slice(renamed ? 9 : 8).join(" "),
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

function displayRef(ref: string): string {
  return ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref.startsWith("refs/remotes/")
      ? ref.slice("refs/remotes/".length)
      : ref;
}
