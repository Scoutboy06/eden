import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { GitModule } from "../../../git/git.module";

export async function createRepository(directory: string) {
  const repo = join(directory, "repo");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"]);

  return repo;
}

export const git = GitModule.execute;
