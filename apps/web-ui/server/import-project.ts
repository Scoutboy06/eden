import type { IncomingMessage, ServerResponse } from "node:http";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

import { createConfigService } from "../../../src/modules/config/config.service";
import { createExecution } from "../../../src/modules/execution";

let pending = Promise.resolve();

export async function importProject(input: unknown) {
  const operation = pending.then(() => saveProject(input));
  pending = operation.then(
    () => {},
    () => {},
  );
  return operation;
}

export async function removeProject(input: unknown) {
  const operation = pending.then(async () => {
    if (!input || typeof input !== "object" || !("key" in input) || typeof input.key !== "string")
      throw new Error("Specify a project key.");
    await createConfigService(createExecution({ dryRun: false })).removeProject(input.key);
  });
  pending = operation.then(
    () => {},
    () => {},
  );
  return operation;
}

async function saveProject(input: unknown) {
  const repository = await resolveRepository(input);
  const name = projectName(input, repository);
  const service = createConfigService(createExecution({ dryRun: false }));
  const projects = (await service.read()).projects ?? {};
  for (const project of Object.values(projects)) {
    if (
      await realpath(project.path).then(
        (existing) => existing === repository,
        () => false,
      )
    )
      throw new Error("This repository is already imported.");
  }
  const base = name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^\.+$|^-+|-+$/g, "") || "project";
  let key = base;
  for (let suffix = 2; Object.hasOwn(projects, key); suffix++) key = `${base}-${suffix}`;
  await service.addProject(key, { name, path: repository });
  return { key, name };
}

export async function handleProjectImport(request: IncomingMessage, response: ServerResponse) {
  if (
    !request.headers.origin ||
    request.headers["sec-fetch-site"] === "cross-site" ||
    !request.headers["content-type"]?.startsWith("application/json")
  ) {
    response.statusCode = 403;
    response.end(JSON.stringify({ error: "Same-origin JSON requests are required." }));
    return;
  }
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 8192) throw new Error("Request is too large.");
    }
    const input: unknown = JSON.parse(body);
    if (request.method === "DELETE") {
      await removeProject(input);
      response.end(JSON.stringify({ removed: true }));
    } else {
      const project = await importProject(input);
      response.statusCode = 201;
      response.end(JSON.stringify({ project }));
    }
  } catch (error) {
    response.statusCode = 400;
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Could not update projects.",
      }),
    );
  }
}

async function resolveRepository(input: unknown) {
  if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string")
    throw new Error("Enter a local repository path.");
  const path = input.path.startsWith("~/") ? resolve(homedir(), input.path.slice(2)) : input.path;
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
  const repository = basename(commonPath) === ".git" ? dirname(commonPath) : root;
  return repository;
}

function projectName(input: unknown, repository: string) {
  const name =
    input !== null && typeof input === "object" && "name" in input && typeof input.name === "string"
      ? input.name.trim()
      : basename(repository);
  if (!name || name.length > 120)
    throw new Error("Enter a project name of at most 120 characters.");
  return name;
}
