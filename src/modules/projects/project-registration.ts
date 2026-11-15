import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type { Execution } from "../execution";
import {
  createProjectRegistry,
  getRegisteredProject,
  listRegisteredProjects,
} from "./project-registry";

export type PreparedProjectRegistration = {
  name: string;
  path: string;
};

export type ProjectRegistrationInput = {
  path: unknown;
  name?: unknown;
};

export type ProjectRegistrationOptions = {
  cwd?: string;
};

export async function prepareProjectRegistration(
  input: ProjectRegistrationInput,
  options: ProjectRegistrationOptions = {},
): Promise<PreparedProjectRegistration> {
  const repository = await resolveRepository(input.path, options.cwd);
  const name = projectName(input.name, repository);
  const projects = await listRegisteredProjects({ dryRun: true });
  for (const project of projects) {
    const existingPath = await realpath(project.path).catch(() => null);
    if (existingPath === repository) throw new Error("This repository is already imported.");
  }
  return { name, path: repository };
}

async function previewProjectRegistration(
  project: PreparedProjectRegistration,
): Promise<{ key: string; name: string; path: string }> {
  return createProjectRegistry().previewNamed(project.name, project.path);
}

async function registerPreparedProject(
  project: PreparedProjectRegistration,
): Promise<{ key: string; name: string; path: string }> {
  return createProjectRegistry().registerNamed(project.name, project.path);
}

export async function registerProject(
  input: ProjectRegistrationInput,
): Promise<{ key: string; name: string; path: string }> {
  return registerPreparedProject(await prepareProjectRegistration(input));
}

export function createProjectRegistrationService(execution: Execution) {
  return {
    async add(
      input: ProjectRegistrationInput,
      options: ProjectRegistrationOptions = {},
    ): Promise<{ key: string; name: string; path: string }> {
      const prepared = await prepareProjectRegistration(input, options);
      const planned = await previewProjectRegistration(prepared);
      let result = planned;
      await execution.mutate(
        {
          type: "project.add",
          description: `Register project ${planned.name} as ${planned.key} (${prepared.path})`,
          input: { ...planned, path: prepared.path },
        },
        async () => {
          result = await registerPreparedProject(prepared);
        },
      );
      return result;
    },
    async remove(key: string): Promise<{ key: string; name: string; path: string }> {
      const project = await getRegisteredProject(key, { dryRun: true });
      await execution.mutate(
        {
          type: "project.remove",
          description: `Remove project ${project.name} (${project.key})`,
          input: { ...project },
        },
        async () => {
          await createProjectRegistry().remove(project.key);
        },
      );
      return project;
    },
  };
}

async function resolveRepository(inputPath: unknown, cwd?: string): Promise<string> {
  if (typeof inputPath !== "string") throw new Error("Enter a local repository path.");

  const expanded = inputPath.startsWith("~/") ? resolve(homedir(), inputPath.slice(2)) : inputPath;
  const path = cwd && !isAbsolute(expanded) ? resolve(cwd, expanded) : expanded;
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("Enter an absolute repository path.");

  const directory = await realpath(path).catch(() => {
    throw new Error("Repository directory does not exist.");
  });
  const git = Bun.spawn(
    ["git", "-C", directory, "rev-parse", "--show-toplevel", "--git-common-dir"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
      },
    },
  );
  const [output, , exit] = await Promise.all([
    new Response(git.stdout).text(),
    new Response(git.stderr).text(),
    git.exited,
  ]);
  if (exit !== 0) throw new Error("Path must be inside an existing Git working repository.");

  const [root, common] = output.trim().split("\n");
  if (!root || !common) throw new Error("Could not resolve repository.");

  const commonPath = await realpath(resolve(directory, common));
  return basename(commonPath) === ".git" ? dirname(commonPath) : root;
}

function projectName(input: unknown, repository: string): string {
  const providedName = typeof input === "string" ? input.trim() : null;
  const name = providedName ?? basename(repository);
  if (!name || name.length > 120)
    throw new Error("Enter a project name of at most 120 characters.");
  return name;
}
