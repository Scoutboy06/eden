import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { ConfigError } from "./errors";
import { ConfigSchema, type Config } from "./schema";

export interface ConfigService {
  read(): Promise<Config>;
}

export function createConfigService(): ConfigService {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

  return createFileConfigService({
    pathsLowToHigh: [join(configHome, "eden", "config.yaml")],
  });
}

export function createFileConfigService(options: {
  pathsLowToHigh: readonly [string];
}): ConfigService {
  const [path] = options.pathsLowToHigh;

  return {
    async read() {
      const text = await readConfigFile(path);
      const parsed = parseConfigYaml(text, path);

      return validateConfig(parsed, path);
    },
  };
}

async function readConfigFile(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

    throw new ConfigError(missing ? "CONFIG_NOT_FOUND" : "CONFIG_READ_FAILED", path);
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
