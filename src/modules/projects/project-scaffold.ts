import { lstat, mkdir, open, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Execution } from "../execution";
import { validateConfig } from "../config/file";
import { findRepositoryPath } from "../config/repository";

export type ProjectScaffoldOptions = { cwd?: string };

export function createProjectScaffoldService(execution: Execution) {
  return {
    async init(inputPath?: unknown, options: ProjectScaffoldOptions = {}) {
      const repository = await resolveRepository(inputPath, options.cwd);
      const configDirectory = join(repository, ".eden");
      const configPath = join(configDirectory, "config.yaml");
      validateConfig({}, configPath);
      await validateDestination(configDirectory, configPath);

      await execution.mutate(
        {
          type: "project.init",
          description: `Create project config ${configPath}`,
          input: { path: repository, configPath },
        },
        async () => createConfig(configDirectory, configPath),
      );

      return { path: repository, configPath };
    },
  };
}

async function resolveRepository(inputPath: unknown, cwd?: string): Promise<string> {
  if (inputPath !== undefined && typeof inputPath !== "string")
    throw new Error("Enter a local repository path.");

  const workingDirectory = cwd ?? process.cwd();
  const expanded =
    inputPath === "~"
      ? homedir()
      : typeof inputPath === "string" && inputPath.startsWith("~/")
        ? resolve(homedir(), inputPath.slice(2))
        : inputPath;
  const selectedPath =
    expanded === undefined
      ? workingDirectory
      : isAbsolute(expanded)
        ? expanded
        : resolve(workingDirectory, expanded);

  if (selectedPath.includes("\0")) throw new Error("Repository path must not contain null bytes.");

  const directory = await realpath(selectedPath).catch(() => {
    throw new Error("Repository directory does not exist.");
  });
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error("Repository path must be a directory.");

  const root = await findRepositoryPath(directory);
  if (!root) throw new Error("Path must be inside an existing Git repository.");

  return realpath(root);
}

async function validateDestination(configDirectory: string, configPath: string): Promise<void> {
  const directory = await lstat(configDirectory).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });

  if (directory?.isSymbolicLink())
    throw new Error("Project .eden directory must not be a symlink.");
  if (directory && !directory.isDirectory())
    throw new Error("Project .eden path must be a directory.");

  const destination = await lstat(configPath).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (destination) throw new Error("Project config already exists; refusing to overwrite it.");
}

async function createConfig(configDirectory: string, configPath: string): Promise<void> {
  let createdDirectory = false;
  let fileCreated = false;

  try {
    try {
      await mkdir(configDirectory);
      createdDirectory = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const directory = await lstat(configDirectory);
    if (directory.isSymbolicLink())
      throw new Error("Project .eden directory must not be a symlink.");
    if (!directory.isDirectory()) throw new Error("Project .eden path must be a directory.");

    const file = await open(configPath, "wx", 0o666);
    fileCreated = true;
    try {
      await file.writeFile("{}\n");
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (fileCreated) await unlink(configPath).catch(() => {});
    if (createdDirectory) await rmdir(configDirectory).catch(() => {});
    if (isAlreadyExists(error))
      throw new Error("Project config already exists; refusing to overwrite it.");
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
