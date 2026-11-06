import { simpleGit } from "simple-git";

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const git = simpleGit({
    baseDir: cwd,
    binary: "git",
    allowEnvironment: ["GIT_TERMINAL_PROMPT"],
    trimmed: false,
    errors: (error, result) =>
      result.exitCode === 0
        ? error
        : new Error(
            error instanceof Error
              ? error.message
              : error?.toString().trim() || `git failed (${result.exitCode})`,
          ),
    unsafe: { allowUnsafeConfigPaths: true, allowUnsafeHooksPath: true },
  }).env("GIT_TERMINAL_PROMPT", "0");
  return git.raw([...args]);
}
