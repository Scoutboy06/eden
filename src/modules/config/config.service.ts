import { homedir } from "node:os";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { Document, parseDocument } from "yaml";
import type { Execution } from "../execution";
import { ConfigYamlEditor } from "./edit";
import { ConfigError } from "./errors";
import { ConfigSchema, type Config } from "./schema";
import { configLeafPath } from "./select";
import { formatConfigPath } from "./path";

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
  editGlobal(): Promise<ConfigDraft>;
}

export type ConfigChanges = Readonly<Record<string, string | undefined>>;
export type ConfigSaveResult = "saved" | "previewed" | "unchanged" | "cancelled";

export interface ConfigDraft {
  readonly path: string;
  readonly config: Config;
  get(key: string): string | undefined;
  save(changes: ConfigChanges, confirmOverwrite: () => Promise<boolean>): Promise<ConfigSaveResult>;
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
    async editGlobal() {
      const { text, parsed } = await readValidatedConfig(path);

      return {
        path,
        config: validateConfig(parsed, path),
        get(key) {
          let value: unknown = parsed;

          for (const part of configLeafPath(key)) {
            value =
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[part]
                : undefined;
          }

          return typeof value === "string" ? value : undefined;
        },
        async save(changes, confirmOverwrite) {
          const { edited, changed } = editDraft(text, changes);

          if (Object.keys(changed).length === 0) return "unchanged";

          validateConfig(parseConfigYaml(edited, path), path);

          if (
            !execution.dryRun &&
            (await readConfigFile(path)) !== text &&
            !(await confirmOverwrite())
          ) {
            return "cancelled";
          }

          await execution.mutate(
            {
              type: "config.setup",
              description: `Update global preferences in ${path}`,
              input: {
                path,
                changes: Object.fromEntries(
                  Object.entries(changed).map(([key, value]) => [key, value ?? null]),
                ),
              },
            },
            () => writeConfigFile(path, edited),
          );

          return execution.dryRun ? "previewed" : "saved";
        },
      };
    },
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

function editDraft(text: string | undefined, changes: ConfigChanges) {
  const document = text === undefined ? new Document({}) : parseDocument(text);
  const changed: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(changes)) {
    const keys = configLeafPath(key);

    if (document.getIn(keys) === value) continue;

    changed[key] = value;
    if (value === undefined) document.deleteIn(keys);
    else document.setIn(keys, value);
  }

  return { edited: document.toString(), changed };
}

function mergeConfigLayer(
  target: Record<string, unknown>,
  layer: Record<string, unknown>,
  provenance: Record<string, ConfigSource>,
  path: string,
  prefix: string[] = [],
): void {
  for (const [key, value] of Object.entries(layer)) {
    const keys = [...prefix, key];

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if (!Object.hasOwn(target, key)) {
        Object.defineProperty(target, key, {
          value: {},
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      const nested = target[key] as Record<string, unknown>;

      mergeConfigLayer(nested, value as Record<string, unknown>, provenance, path, keys);
    } else {
      Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      provenance[formatConfigPath(keys)] = { type: "file", path };
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
  let temporary: string | undefined;

  try {
    const destination = await realpath(path).catch(async (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;

      const entry = await lstat(path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;

        throw error;
      });

      if (entry?.isSymbolicLink()) throw error;

      return path;
    });
    await mkdir(dirname(destination), { recursive: true });
    const mode = await stat(destination)
      .then((info) => info.mode & 0o777)
      .catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0o600;

        throw error;
      });
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
      path: formatConfigPath(issue.path?.map((item) => String(item.key)) ?? []),
      message: issue.message,
    }));

    throw new ConfigError("CONFIG_SCHEMA_INVALID", path, issues);
  }

  return result.output;
}
