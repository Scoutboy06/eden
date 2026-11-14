import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { findRepositoryPath } from "../config/repository";
import { SandboxError } from "./errors";

export async function findCheckout(cwd: string): Promise<string> {
  const repository = await findRepositoryPath(cwd);
  if (repository === undefined) {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      "Not inside a Git checkout. Run from a checkout or pass --name.",
    );
  }

  return resolveRealPath(repository);
}

export function deriveSandboxName(checkout: string): string {
  const folder = basename(checkout);
  const parent = basename(dirname(checkout));
  const source = folder.toLowerCase() === "repo" && parent !== "" ? parent : folder;
  const name = sanitizeSandboxName(source);

  if (name.length < 2 || name.length > 63 || name === "default") {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      `Cannot derive a sandbox name from ${JSON.stringify(source)}. Pass --name.`,
    );
  }

  return name;
}

export async function pathKey(path: string): Promise<string> {
  const target = path.replace(/:(ro|rw)$/i, "");
  const real = await resolveRealPath(target);
  const normalized = real.replaceAll("\\", "/").replace(/\/+$/, "");
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;

  return key === "" ? "/" : key;
}

async function resolveRealPath(path: string): Promise<string> {
  const absolute = resolve(path);

  return realpath(absolute).catch(() => absolute);
}

function sanitizeSandboxName(value: string): string {
  const parts = value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .split(".")
    .map((part) => part.replace(/^-+|-+$/g, ""))
    .filter((part) => part !== "");

  return parts
    .join(".")
    .slice(0, 63)
    .replace(/[-.]+$/, "");
}
