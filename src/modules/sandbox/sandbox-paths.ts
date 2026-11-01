import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findRepositoryPath } from "../config/repository";
import { SandboxError } from "./errors";
import type { CreateSandboxInput } from "./provider";

type Mount = { path: string; readonly?: boolean };

export async function resolveSandboxPaths(
  input: CreateSandboxInput,
  explicitPath?: string,
): Promise<void> {
  const workspace = input.workspace;
  const mounts = input.mounts ?? {};
  const { mode, source } = await workspaceSource(workspace, explicitPath, mounts);

  const value = createValueResolver(input.name, mode, mounts, source);

  if (workspace && mode !== "none") {
    input.workspace = { mode, path: value("workspace.path") };
    await requireDirectory(input.workspace.path!, "Workspace");
  }
  if (input.mounts !== undefined) input.mounts = await resolveMounts(mounts, value);
  if (input.kitArgs) input.kitArgs = resolveKitArguments(input.kitArgs, value);
}

async function workspaceSource(
  workspace: CreateSandboxInput["workspace"],
  explicitPath: string | undefined,
  mounts: Record<string, Mount>,
): Promise<{ mode: "none" | "clone" | "host"; source?: string }> {
  const mode = workspace?.mode ?? "none";
  if (mode === "none" && (explicitPath !== undefined || workspace?.path !== undefined)) {
    throw invalid("A workspace path requires profile workspace mode clone or host.");
  }
  if (mode === "none" && Object.keys(mounts).length) {
    throw invalid(
      "Named mounts require a clone or host workspace: sbx treats the first path as its primary workspace.",
    );
  }
  const source =
    explicitPath ??
    workspace?.path ??
    (mode !== "none" ? await findRepositoryPath(process.cwd()) : undefined);
  if (mode !== "none" && source === undefined) {
    throw invalid("Workspace requires --path, a profile path, or a current repository.");
  }
  return { mode, source };
}

async function resolveMounts(
  mounts: Record<string, Mount>,
  value: (key: string) => string,
): Promise<Record<string, Mount>> {
  const resolved: Record<string, Mount> = Object.create(null);
  for (const [name, mount] of Object.entries(mounts)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      throw invalid(`Invalid mount name: ${JSON.stringify(name)}.`);
    const path = value(`mounts.${name}.hostPath`);
    await requireDirectory(path, `Mount ${name}`);
    resolved[name] = { ...mount, path };
  }
  return resolved;
}

function resolveKitArguments(
  args: NonNullable<CreateSandboxInput["kitArgs"]>,
  value: (key: string) => string,
): NonNullable<CreateSandboxInput["kitArgs"]> {
  return Object.fromEntries(
    Object.entries(args).map(([key, argument]) => [
      key,
      typeof argument === "string" ? interpolate(argument, value) : argument,
    ]),
  );
}

function createValueResolver(
  sandboxName: string,
  mode: string,
  mounts: Record<string, Mount>,
  workspacePath?: string,
): (key: string) => string {
  const cache = new Map<string, string>();
  const resolving = new Set<string>();
  const value = (key: string): string => {
    if (cache.has(key)) return cache.get(key)!;
    if (resolving.has(key)) throw invalid(`Cyclic interpolation: ${key}.`);
    resolving.add(key);
    let result: string;
    if (key === "sandbox.name") result = sandboxName;
    else if (key === "workspace.mode") result = mode;
    else if (key === "workspace.path" && mode !== "none")
      result = hostPath(interpolate(workspacePath!, value), "Workspace");
    else {
      const match = /^mounts\.([A-Za-z0-9_-]+)\.(hostPath|sandboxPath)$/.exec(key);
      const name = match?.[1];
      if (!name || !Object.hasOwn(mounts, name))
        throw invalid(`Unknown or unavailable interpolation: ${key}.`);
      const host = hostPath(interpolate(mounts[name]!.path, value), `Mount ${name}`);
      result = match![2] === "hostPath" ? host : sandboxPath(host);
    }
    resolving.delete(key);
    cache.set(key, result);
    return result;
  };

  return value;
}

function interpolate(text: string, value: (key: string) => string): string {
  const result = text.replace(/\$\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key: string) => value(key));
  if (result.includes("${{")) throw invalid(`Invalid interpolation in ${JSON.stringify(text)}.`);
  return result;
}

function hostPath(path: string, subject: string): string {
  if (!path.trim() || path.includes("\0"))
    throw invalid(`${subject} path must not be empty or contain null bytes.`);
  const expanded =
    path === "~"
      ? homedir()
      : /^~[\\/]/.test(path)
        ? join(homedir(), path.slice(2).replaceAll("\\", "/"))
        : path;
  const absolute = resolve(expanded);
  const remainder = process.platform === "win32" ? absolute.replace(/^[A-Za-z]:/, "") : absolute;
  if (
    remainder.includes(":") ||
    (process.platform === "win32" &&
      subject.startsWith("Mount ") &&
      !/^[A-Za-z]:[\\/]/.test(absolute))
  ) {
    throw invalid(`${subject} path cannot be represented safely by sbx: ${absolute}`);
  }
  return absolute;
}

export function sandboxPath(path: string): string {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (drive) return `/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll("\\", "/")}`;
  if (path.startsWith("/")) return path;
  throw invalid(`Mount path cannot be represented in the sandbox: ${path}`);
}

async function requireDirectory(path: string, subject: string): Promise<void> {
  if (!(await stat(path).catch(() => undefined))?.isDirectory())
    throw invalid(`${subject} path is not an existing directory: ${path}`);
}

function invalid(message: string): SandboxError {
  return new SandboxError("SANDBOX_INVALID_INPUT", message);
}
