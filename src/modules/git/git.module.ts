import { basename } from "node:path";

export class GitModule {
  static async execute(cwd: string, args: readonly string[]): Promise<string> {
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

    return stdout.trim();
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
