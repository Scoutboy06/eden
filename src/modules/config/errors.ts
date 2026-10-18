export type ConfigIssue = { path: string; message: string };

export type ConfigErrorCode =
  | "CONFIG_EMPTY"
  | "CONFIG_READ_FAILED"
  | "CONFIG_WRITE_FAILED"
  | "CONFIG_YAML_INVALID"
  | "CONFIG_SCHEMA_INVALID";

const messages: Record<ConfigErrorCode, string> = {
  CONFIG_EMPTY: "configuration file is empty",
  CONFIG_READ_FAILED: "configuration file could not be read",
  CONFIG_WRITE_FAILED: "configuration file could not be written",
  CONFIG_YAML_INVALID: "configuration file contains invalid YAML",
  CONFIG_SCHEMA_INVALID: "configuration does not match the schema",
};

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    readonly path: string,
    readonly issues: readonly ConfigIssue[] = [],
  ) {
    super(`${path}: ${messages[code]}`);
    this.name = "ConfigError";
  }
}
