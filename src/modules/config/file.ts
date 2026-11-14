import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { ConfigError } from "./errors";
import { formatConfigPath } from "./path";
import { ConfigSchema, type Config } from "./schema";

export async function readValidatedConfig(
  path: string,
): Promise<{ text: string | undefined; parsed: Record<string, unknown> }> {
  const text = await readConfigFile(path);
  const parsed = parseConfigYaml(text ?? "{}", path);

  validateConfig(parsed, path);

  return { text, parsed: parsed as Record<string, unknown> };
}

export async function writeConfigFile(path: string, text: string): Promise<void> {
  let temporary: string | undefined;

  try {
    const destination = await resolveConfigDestination(path);
    await mkdir(dirname(destination), { recursive: true });
    const mode = await readConfigMode(destination);
    temporary = join(dirname(destination), `.eden-config-${crypto.randomUUID()}.tmp`);
    const file = await open(temporary, "wx", mode);

    try {
      await file.chmod(mode);
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, destination);
  } catch {
    throw new ConfigError("CONFIG_WRITE_FAILED", path);
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readConfigFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

    if (missing) return undefined;

    throw new ConfigError("CONFIG_READ_FAILED", path);
  }
}

export function parseConfigYaml(text: string, path: string): unknown {
  const isCommentOnly = /^\s*(?:#[^\r\n]*(?:\r?\n|$)\s*)*$/u.test(text);

  if (isCommentOnly) throw new ConfigError("CONFIG_EMPTY", path);

  try {
    return Bun.YAML.parse(text);
  } catch {
    throw new ConfigError("CONFIG_YAML_INVALID", path);
  }
}

export function validateConfig(parsed: unknown, path: string): Config {
  const result = v.safeParse(ConfigSchema, parsed);

  if (!result.success) {
    const issues = result.issues.map((issue) => ({
      path: formatConfigPath(issue.path?.map((item) => String(item.key)) ?? []),
      message: issue.message,
    }));

    throw new ConfigError("CONFIG_SCHEMA_INVALID", path, issues);
  }

  return result.output;
}

async function resolveConfigDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const missingDestination = isMissingPathError(error);

    if (!missingDestination) throw error;

    const entry = await lstat(path).catch((entryError: unknown) => {
      if (isMissingPathError(entryError)) return undefined;

      throw entryError;
    });
    const isDanglingSymlink = entry?.isSymbolicLink();

    if (isDanglingSymlink) throw error;

    return path;
  }
}

async function readConfigMode(path: string): Promise<number> {
  try {
    const info = await stat(path);

    return info.mode & 0o777;
  } catch (error) {
    const missingDestination = isMissingPathError(error);

    if (missingDestination) return 0o600;

    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
