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

export interface ConfigService extends ConfigReader {
  set(key: string, value: string): Promise<void>;
}

export type FileConfigOptions = { pathsLowToHigh: readonly [string] };

export function createConfigService(execution: Execution): ConfigService;
export function createConfigService(): ConfigReader;
export function createConfigService(execution?: Execution): ConfigReader {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

  const options: FileConfigOptions = { pathsLowToHigh: [join(configHome, "eden", "config.yaml")] };

  return execution
    ? createFileConfigService({ ...options, execution })
    : createFileConfigService(options);
}

export function createFileConfigService(
  options: FileConfigOptions & { execution: Execution },
): ConfigService;
export function createFileConfigService(options: FileConfigOptions): ConfigReader;
export function createFileConfigService(
  options: FileConfigOptions & { execution?: Execution },
): ConfigReader {
  const [path] = options.pathsLowToHigh;
  const { execution } = options;

  const reader: ConfigReader = {
    async read() {
      const { config } = await readValidatedConfig(path);

      return config;
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

async function prepareConfigUpdate(path: string, key: string, value: string): Promise<string> {
  const { text } = await readValidatedConfig(path);
  const keys = configLeafPath(key);
  const edited = new ConfigYamlEditor(text).set(keys, value);

  validateConfig(parseConfigYaml(edited, path), path);

  return edited;
}

async function readValidatedConfig(
  path: string,
): Promise<{ text: string | undefined; config: Config }> {
  const text = await readConfigFile(path);
  const parsed = parseConfigYaml(text ?? "{}", path);

  return { text, config: validateConfig(parsed, path) };
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
