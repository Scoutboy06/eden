import { simpleGit } from "simple-git";

const guardedVariables = new Set(["editor", "pager", "prefix", "ssh_askpass", "visual"]);

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const git = simpleGit({
    baseDir: cwd,
    binary: "git",
    allowEnvironment: ["GIT_TERMINAL_PROMPT"],
    trimmed: false,
    errors: (error, result) => {
      if (result.exitCode === 0) return error;

      const message =
        error instanceof Error
          ? error.message
          : error?.toString().trim() || `git failed (${result.exitCode})`;
      return new Error(message);
    },
    unsafe: { allowUnsafeConfigPaths: true, allowUnsafeHooksPath: true },
  }).env({ ...unguardedEnvironment(), GIT_TERMINAL_PROMPT: "0" });
  return git.raw([...args]);
}

function unguardedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !isGuarded(entry[0]),
    ),
  );
}

function isGuarded(name: string): boolean {
  const key = name.toLowerCase().trim();
  return key.startsWith("git_") || guardedVariables.has(key);
}
