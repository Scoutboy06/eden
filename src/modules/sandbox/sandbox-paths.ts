import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findRepositoryPath } from "../config/repository";
import { SandboxError } from "./errors";
import type { CreateSandboxInput } from "./provider";

export async function resolveSandboxPaths(
  input: CreateSandboxInput,
  explicitPath?: string,
): Promise<void> {
  const workspace = input.workspace;
  const mode = workspace?.mode ?? "none";
  if (mode === "none" && (explicitPath !== undefined || workspace?.path !== undefined))
    throw invalid("A workspace path requires profile workspace mode clone or host.");
  const configured = explicitPath ?? workspace?.path;
  const fallback =
    mode !== "none" && configured === undefined
      ? await findRepositoryPath(process.cwd())
      : undefined;
  if (mode !== "none" && configured === undefined && !fallback)
    throw invalid("Workspace requires --path, a profile path, or a current repository.");
  let resolving = false;
  let workspacePath: string | undefined;
  const value = (key: string): string => {
    if (key === "sandbox.name") return input.name;
    if (key === "workspace.mode") return mode;
    if (key !== "workspace.path" || mode === "none")
      throw invalid(`Unknown or unavailable interpolation: ${key}.`);
    if (workspacePath !== undefined) return workspacePath;
    if (resolving) throw invalid("Cyclic interpolation: workspace.path.");
    resolving = true;
    const raw = interpolate(configured ?? fallback!, value);
    if (!raw.trim() || raw.includes("\0"))
      throw invalid("Workspace path must not be empty or contain null bytes.");
    const expanded =
      raw === "~"
        ? homedir()
        : /^~[\\/]/.test(raw)
          ? join(homedir(), raw.slice(2).replaceAll("\\", "/"))
          : raw;
    workspacePath = resolve(expanded);
    const remainder =
      process.platform === "win32" ? workspacePath.replace(/^[A-Za-z]:/, "") : workspacePath;
    if (remainder.includes(":"))
      throw invalid(`Workspace path cannot be represented safely by sbx: ${workspacePath}`);
    resolving = false;
    return workspacePath;
  };
  if (workspace && mode !== "none") {
    const path = value("workspace.path");
    if (!(await stat(path).catch(() => undefined))?.isDirectory())
      throw invalid(`Workspace path is not an existing directory: ${path}`);
    input.workspace = { mode, path };
  }
  if (input.kitArgs)
    input.kitArgs = Object.fromEntries(
      Object.entries(input.kitArgs).map(([key, argument]) => [
        key,
        typeof argument === "string" ? interpolate(argument, value) : argument,
      ]),
    );
}

function interpolate(text: string, value: (key: string) => string): string {
  const result = text.replace(/\$\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key: string) => value(key));
  if (result.includes("${{")) throw invalid(`Invalid interpolation in ${JSON.stringify(text)}.`);
  return result;
}

function invalid(message: string): SandboxError {
  return new SandboxError("SANDBOX_INVALID_INPUT", message);
}
