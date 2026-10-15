import { lstat, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ConfigService } from "../config/config.service";
import type { Execution } from "../execution";
import { git } from "./git";

export type CreateWorktreeInput = { name: string; baseBranch?: string };
export type Worktree = { branch: string; path: string; base: string };

export class WorktreeService {
  constructor(
    private readonly execution: Execution,
    private readonly config: ConfigService,
  ) {}

  async create(input: CreateWorktreeInput, cwd = process.cwd()): Promise<Worktree> {
    const branch = sanitizeName(input.name);
    await git(cwd, ["check-ref-format", "--branch", branch]);

    const settings = await this.config.read();
    const repositoryName = await resolveRepositoryName(cwd);
    const path = join(settings.worktree_root, repositoryName, branch);
    const base = await resolveBase(cwd, input.baseBranch);
    await assertAvailable(cwd, branch, path);

    const result = { branch, path, base };

    await this.execution.mutate(
      {
        type: "git.worktree.create",
        description: `Create worktree ${branch} at ${path}`,
        input: result,
      },
      async () => {
        await mkdir(dirname(path), { recursive: true });
        await git(cwd, ["worktree", "add", "-b", branch, "--", path, base]);
      },
    );

    return result;
  }
}

function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  if (!sanitized) throw new Error("Worktree name must contain letters or numbers");

  return sanitized;
}

async function resolveRepositoryName(cwd: string): Promise<string> {
  const listing = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
  const mainPath = listing.split("\0")[0]?.slice("worktree ".length);

  if (!mainPath || (await git(cwd, ["rev-parse", "--is-bare-repository"])) === "true") {
    throw new Error("Worktree creation requires a non-bare Git repository");
  }

  return basename(mainPath);
}

function resolveBase(cwd: string, ref = "HEAD"): Promise<string> {
  return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

async function assertAvailable(cwd: string, branch: string, path: string): Promise<void> {
  const branches = await git(cwd, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]);

  if (branches.split("\n").includes(`refs/heads/${branch}`)) {
    throw new Error(`Branch already exists: ${branch}`);
  }

  if (await destinationExists(path)) {
    throw new Error(`Worktree destination already exists: ${path}`);
  }
}

async function destinationExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;

    throw error;
  }
}
