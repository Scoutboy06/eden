import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import type { Execution } from "../execution";
import { ConfigYamlEditor } from "./edit";
import { ConfigError } from "./errors";
import { ConfigSchema, type Config } from "./schema";
import { configLeafPath } from "./select";

export interface ConfigReader {
  read(): Promise<Config>;
}

export interface ResolvedConfigReader extends ConfigReader {
  readWithProvenance(): Promise<ResolvedConfig>;
}

export type ConfigSource = { type: "file"; path: string } | { type: "default" };
export type ResolvedConfig = { config: Config; provenance: Record<string, ConfigSource> };

export interface ConfigService extends ResolvedConfigReader {
  set(key: string, value: string): Promise<void>;
}

export type FileConfigOptions = { pathsLowToHigh: readonly [string, ...string[]] };
export type ConfigContext = { repositoryPath?: string };

export function createConfigService(execution: Execution, context?: ConfigContext): ConfigService;
export function createConfigService(
  execution?: undefined,
  context?: ConfigContext,
): ResolvedConfigReader;
export function createConfigService(
  execution?: Execution,
  context: ConfigContext = {},
): ResolvedConfigReader {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

  const options: FileConfigOptions = { pathsLowToHigh: [join(configHome, "eden", "config.yaml")] };

  if (context.repositoryPath !== undefined) {
    options.pathsLowToHigh = [
      ...options.pathsLowToHigh,
      join(context.repositoryPath, ".eden", "config.yaml"),
      join(context.repositoryPath, ".eden", "config.local.yaml"),
    ];
  }

  return execution
    ? createFileConfigService({ ...options, execution })
    : createFileConfigService(options);
}

export function createFileConfigService(
  options: FileConfigOptions & { execution: Execution },
): ConfigService;
export function createFileConfigService(options: FileConfigOptions): ResolvedConfigReader;
export function createFileConfigService(
  options: FileConfigOptions & { execution?: Execution },
): ResolvedConfigReader {
  const [path] = options.pathsLowToHigh;
  const { execution } = options;

  const reader: ResolvedConfigReader = {
    async read() {
      const { config } = await reader.readWithProvenance();

      return config;
    },
    async readWithProvenance() {
      const merged: Record<string, unknown> = {};
      const provenance: Record<string, ConfigSource> = {};

      for (const layerPath of options.pathsLowToHigh) {
        const { parsed } = await readValidatedConfig(layerPath);

        mergeConfigLayer(merged, parsed, provenance, layerPath);
      }

      const config = validateConfig(merged, path);

      if (!provenance.worktree_root) provenance.worktree_root = { type: "default" };

      return { config, provenance };
    },
  };

  if (!execution) return reader;

  const service: ConfigService = {
    ...reader,
    async set(key, value) {
      const edited = await prepareConfigUpdate(path, key, value);

      await execution.mutate(
        {
          type: "config.set",
          description: `Set configuration ${key} to ${JSON.stringify(value)}`,
          input: { path, key, value },
        },
        () => writeConfigFile(path, edited),
      );
    },
  };

  return service;
}

function mergeConfigLayer(
  target: Record<string, unknown>,
  layer: Record<string, unknown>,
  provenance: Record<string, ConfigSource>,
  path: string,
  prefix = "",
): void {
  for (const [key, value] of Object.entries(layer)) {
    const leafPath = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = (target[key] ??= {}) as Record<string, unknown>;

      mergeConfigLayer(nested, value as Record<string, unknown>, provenance, path, leafPath);
    } else {
      target[key] = value;
      provenance[leafPath] = { type: "file", path };
    }
  }
}

async function prepareConfigUpdate(path: string, key: string, value: string): Promise<string> {
  const { text } = await readValidatedConfig(path);
  const keys = configLeafPath(key);
  const edited = new ConfigYamlEditor(text).set(keys, value);

  validateConfig(parseConfigYaml(edited, path), path);

  return edited;
}

async function readValidatedConfig(
  path: string,
): Promise<{ text: string | undefined; parsed: Record<string, unknown> }> {
  const text = await readConfigFile(path);
  const parsed = parseConfigYaml(text ?? "{}", path);

  validateConfig(parsed, path);

  return { text, parsed: parsed as Record<string, unknown> };
}

async function writeConfigFile(path: string, text: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  } catch {
    throw new ConfigError("CONFIG_WRITE_FAILED", path);
  }
}

async function readConfigFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

    if (missing) return undefined;

    throw new ConfigError("CONFIG_READ_FAILED", path);
  }
}

function parseConfigYaml(text: string, path: string): unknown {
  if (/^\s*(?:#[^\r\n]*(?:\r?\n|$)\s*)*$/u.test(text)) {
    throw new ConfigError("CONFIG_EMPTY", path);
  }

  try {
    return Bun.YAML.parse(text);
  } catch {
    throw new ConfigError("CONFIG_YAML_INVALID", path);
  }
}

function validateConfig(parsed: unknown, path: string): Config {
  const result = v.safeParse(ConfigSchema, parsed);

  if (!result.success) {
    const issues = result.issues.map((issue) => ({
      path: issue.path?.map((item) => String(item.key)).join(".") ?? "",
      message: issue.message,
    }));

    throw new ConfigError("CONFIG_SCHEMA_INVALID", path, issues);
  }

  return result.output;
}
