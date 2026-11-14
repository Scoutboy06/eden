import { basename } from "node:path";
import { runGit } from "../../external/simple-git/git";
import { parseRepositoryStatus } from "./status";

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

export type GitWorktree = {
  path: string;
  branch: string | null;
};

export type GitCommit = {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  body: string;
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

  static async worktrees(cwd: string): Promise<GitWorktree[]> {
    await GitModule.executeRaw(cwd, ["rev-parse", "--git-dir"]);
    const output = await GitModule.executeRaw(cwd, ["worktree", "list", "--porcelain", "-z"]);
    const worktrees: GitWorktree[] = [];
    let path: string | undefined;
    let branch: string | null = null;
    for (const record of output.split("\0")) {
      if (record.startsWith("worktree ")) {
        if (path !== undefined) worktrees.push({ path, branch });
        path = record.slice("worktree ".length);
        branch = null;
      } else if (record.startsWith("branch ")) {
        branch = displayRef(record.slice("branch ".length));
      }
    }
    if (path !== undefined) worktrees.push({ path, branch });

    return worktrees;
  }

  static async showBranch(cwd: string, name: string): Promise<GitLocalBranch> {
    const ref = await localBranchRef(cwd, name);
    const branch = (await GitModule.localBranches(cwd)).find(
      (item) => `refs/heads/${item.name}` === ref,
    );
    if (!branch) throw new Error(`Local branch not found: ${name}`);
    return branch;
  }

  static async createBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
    await GitModule.validateNewBranch(cwd, name, startPoint);
    const args = ["branch", "--", name];
    if (startPoint !== undefined) args.push(await resolveLocalRevision(cwd, startPoint));
    await GitModule.execute(cwd, args);
  }

  static async renameBranch(cwd: string, oldName: string, newName: string): Promise<void> {
    await GitModule.validateRenameBranch(cwd, oldName, newName);
    const oldRef = await localBranchRef(cwd, oldName);
    await GitModule.execute(cwd, [
      "branch",
      "-m",
      "--",
      oldRef.slice("refs/heads/".length),
      newName,
    ]);
  }

  static async deleteBranch(cwd: string, name: string, force = false): Promise<void> {
    await GitModule.validateDeleteBranch(cwd, name, force);
    const ref = await localBranchRef(cwd, name);
    await GitModule.execute(cwd, [
      "branch",
      force ? "-D" : "-d",
      "--",
      ref.slice("refs/heads/".length),
    ]);
  }

  static async publishBranch(
    cwd: string,
    name: string,
    remote: string,
    forceWithLease = false,
  ): Promise<void> {
    await GitModule.validatePublishBranch(cwd, name, remote);
    const ref = await localBranchRef(cwd, name);
    await GitModule.execute(cwd, [
      "push",
      ...(forceWithLease ? ["--force-with-lease"] : []),
      "--",
      remote,
      `${ref}:${ref}`,
    ]);
  }

  static async fetch(cwd: string, remote: string): Promise<void> {
    GitModule.validateRemote(remote);
    await GitModule.execute(cwd, ["fetch", "--", remote]);
  }

  static async validateNewBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
    await validateBranchName(cwd, name);
    if ((await GitModule.localBranches(cwd)).some((branch) => branch.name === name)) {
      throw new Error(`Local branch already exists: ${name}`);
    }
    if (startPoint !== undefined) await resolveLocalRevision(cwd, startPoint);
  }

  static async validateRenameBranch(cwd: string, oldName: string, newName: string): Promise<void> {
    await localBranchRef(cwd, oldName);
    await validateBranchName(cwd, newName);
    if ((await GitModule.localBranches(cwd)).some((branch) => branch.name === newName)) {
      throw new Error(`Local branch already exists: ${newName}`);
    }
  }

  static async validateDeleteBranch(cwd: string, name: string, force = false): Promise<void> {
    const ref = await localBranchRef(cwd, name);
    const branch = (await GitModule.localBranches(cwd)).find(
      (item) => `refs/heads/${item.name}` === ref,
    );
    if (branch?.worktrees.length) {
      throw new Error(`Cannot delete branch checked out in a worktree: ${name}`);
    }
    if (force || !branch) return;

    const upstream = await GitModule.execute(cwd, ["for-each-ref", "--format=%(upstream)", ref]);
    const target = upstream || "HEAD";
    try {
      const unmerged = await GitModule.execute(cwd, ["rev-list", "--count", `${target}..${ref}`]);
      if (Number(unmerged) > 0) throw new Error(`Branch is not fully merged: ${name}`);
    } catch {
      throw new Error(`Branch is not fully merged: ${name}`);
    }
  }

  static async validatePublishBranch(cwd: string, name: string, remote: string): Promise<void> {
    await localBranchRef(cwd, name);
    GitModule.validateRemote(remote);
  }

  static validateRemote(remote: string): void {
    if (!remote || remote.startsWith("-") || remote.includes("\0"))
      throw new Error("Invalid remote name");
  }

  static async commitHistory(
    cwd: string,
    input: { ref?: string; limit?: number } = {},
  ): Promise<GitCommit[]> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("History limit must be an integer from 1 to 500");
    const ref = input.ref === undefined ? "HEAD" : await resolveLocalRevision(cwd, input.ref);
    const format = "%H%x00%P%x00%an%x00%ae%x00%aI%x00";
    const output = await GitModule.executeRaw(cwd, [
      "log",
      "-z",
      `--max-count=${limit}`,
      `--format=${format}`,
      "--end-of-options",
      ref,
    ]);
    return GitModule.parseCommitHistory(cwd, output);
  }

  private static async readCommitMessage(
    cwd: string,
    hash: string,
  ): Promise<{ subject: string; body: string }> {
    const rawCommit = await GitModule.executeRaw(cwd, ["cat-file", "commit", hash]);
    const message = rawCommit.slice(rawCommit.indexOf("\n\n") + 2);
    const lineEnd = message.indexOf("\n");
    const messageBody = lineEnd === -1 ? "" : message.slice(lineEnd + 1);
    return {
      subject: lineEnd === -1 ? message : message.slice(0, lineEnd),
      body: messageBody.startsWith("\n") ? messageBody.slice(1) : messageBody,
    };
  }

  private static async parseCommit(cwd: string, fields: string[]): Promise<GitCommit | null> {
    const [hash, parents, authorName, authorEmail, authoredAt] = fields;
    if (!hash) return null;
    const message = await GitModule.readCommitMessage(cwd, hash);
    return {
      hash,
      parents: parents ? parents.split(" ") : [],
      authorName: authorName!,
      authorEmail: authorEmail!,
      authoredAt: authoredAt!,
      ...message,
    };
  }

  private static async parseCommitHistory(cwd: string, output: string): Promise<GitCommit[]> {
    const fields = output.split("\0");
    const commits: GitCommit[] = [];
    let i = 0;
    while (i + 4 < fields.length) {
      const commit = await GitModule.parseCommit(cwd, fields.slice(i, i + 5));
      i += 5;
      if (!commit) break;
      commits.push(commit);
      if (fields[i] === "") i += 1;
    }
    return commits;
  }

  private static async executeRaw(cwd: string, args: readonly string[]): Promise<string> {
    return runGit(cwd, args);
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

function displayRef(ref: string): string {
  return ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref.startsWith("refs/remotes/")
      ? ref.slice("refs/remotes/".length)
      : ref;
}

async function validateBranchName(cwd: string, name: string): Promise<void> {
  if (!name || name.startsWith("-") || name.includes("\0") || name.startsWith("refs/")) {
    throw new Error("Invalid local branch name");
  }
  await GitModule.execute(cwd, ["check-ref-format", "--branch", name]);
}

async function localBranchRef(cwd: string, input: string): Promise<string> {
  if (!input || input.startsWith("-") || input.includes("\0"))
    throw new Error("Invalid local branch name");
  const name = input.startsWith("refs/heads/") ? input.slice("refs/heads/".length) : input;
  await validateBranchName(cwd, name);
  const ref = `refs/heads/${name}`;
  const found = await GitModule.execute(cwd, ["for-each-ref", "--format=%(refname)", ref]);
  if (found !== ref) {
    throw new Error(`Local branch not found: ${input}`);
  }
  return ref;
}

async function resolveLocalRevision(cwd: string, input: string): Promise<string> {
  if (!input || input.startsWith("-") || input.includes("\0"))
    throw new Error("Invalid local commit reference");
  const isObjectId = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(input);
  const ref = isObjectId ? input : input.startsWith("refs/heads/") ? input : `refs/heads/${input}`;
  const resolved = await GitModule.execute(cwd, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]).catch(() => {
    throw new Error(`Local branch or commit not found: ${input}`);
  });
  return resolved;
}
