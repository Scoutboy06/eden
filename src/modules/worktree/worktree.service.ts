import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HookService, type HookInput } from "../hook/hook.service";
import type { ConfigReader } from "../config/config.service";
import type { Execution } from "../execution";
import { GitModule } from "../git/git.module";

export type CreateWorktreeInput = { name: string; baseBranch?: string };
export type Worktree = { branch: string; path: string; base: string };

export class WorktreeService {
  constructor(
    private readonly execution: Execution,
    private readonly config: ConfigReader,
    private readonly hooks: HookService = new HookService(execution),
  ) {}

  async create(input: CreateWorktreeInput, cwd = process.cwd()): Promise<Worktree> {
    const branch = sanitizeName(input.name);

    const settings = await this.config.read();
    const repositoryName = await GitModule.repositoryName(cwd);
    const path = join(settings.worktree_root, repositoryName, branch);
    const base = await GitModule.resolveCommit(cwd, input.baseBranch);
    const context = { cwd, repositoryName, worktreeRoot: settings.worktree_root };
    const [pre, post] = await Promise.all([
      this.hooks.discover("worktree.create.pre"),
      this.hooks.discover("worktree.create.post"),
    ]);
    const proposed = { branch, path, base };
    const result = await this.applyPreHook(pre, { request: input, context, proposed });

    await this.execution.mutate(
      {
        type: "git.worktree.create",
        description: `Create worktree ${result.branch} at ${result.path}`,
        input: result,
      },
      async () => {
        await mkdir(dirname(resolve(cwd, result.path)), { recursive: true });
        await GitModule.createWorktree(cwd, result);
      },
    );

    await this.runPostHook(post, { request: input, context, result });

    return result;
  }

  private async applyPreHook(
    path: string | undefined,
    input: HookInput & { proposed: Worktree },
  ): Promise<Worktree> {
    if (!path) return input.proposed;

    const response = await this.hooks.run(
      "worktree.create.pre",
      path,
      input,
      input.context.cwd,
      "pre",
    );

    return { ...input.proposed, ...response.overwrites };
  }

  private async runPostHook(
    path: string | undefined,
    input: HookInput & { result: Worktree },
  ): Promise<void> {
    if (!path) return;

    await this.hooks.run(
      "worktree.create.post",
      path,
      input,
      resolve(input.context.cwd, input.result.path),
      "post",
    );
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
