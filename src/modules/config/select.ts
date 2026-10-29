import type * as v from "valibot";
import { ConfigSchema, type Config } from "./schema";
import { parseConfigPath } from "./path";

export function selectConfig(config: Config, path?: string): unknown {
  if (path === undefined) return config;

  let value: unknown = config;

  for (const key of resolveSetting(path).keys) {
    value =
      value !== undefined && value !== null && Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }

  return value;
}

export function configLeafPath(path: string): string[] {
  const { keys, schema } = resolveSetting(path);

  if (schemaEntries(schema) || schemaValue(schema) || unwrapSchema(schema).type === "array") {
    throw Object.assign(new Error(`Configuration key is not a leaf setting: ${path}`), {
      code: "CONFIG_KEY_NOT_LEAF",
    });
  }

  return keys;
}

function resolveSetting(path: string): { keys: string[]; schema: v.GenericSchema } {
  const keys = parseConfigPath(path);
  let schema: v.GenericSchema = ConfigSchema;

  for (const key of keys) {
    const entries = schemaEntries(schema);
    const value = schemaValue(schema);

    if (value) {
      schema = value;
      continue;
    }

    if (!entries || !Object.hasOwn(entries, key)) {
      throw Object.assign(new Error(`Unknown configuration key: ${path}`), {
        code: "CONFIG_KEY_UNKNOWN",
      });
    }

    schema = entries[key]!;
  }

  return { keys, schema };
}

function schemaValue(schema: v.GenericSchema): v.GenericSchema | undefined {
  const unwrapped = unwrapSchema(schema);

  return "key" in unwrapped && "value" in unwrapped
    ? (unwrapped.value as v.GenericSchema)
    : undefined;
}

function unwrapSchema(schema: v.GenericSchema): v.GenericSchema {
  if ("wrapped" in schema) return unwrapSchema(schema.wrapped as v.GenericSchema);

  return schema;
}

function schemaEntries(schema: v.GenericSchema): Record<string, v.GenericSchema> | undefined {
  if ("entries" in schema) return schema.entries as Record<string, v.GenericSchema>;
  if ("wrapped" in schema) return schemaEntries(schema.wrapped as v.GenericSchema);
  if ("pipe" in schema) {
    for (const item of schema.pipe as v.GenericSchema[]) {
      const entries = schemaEntries(item);

      if (entries) return entries;
    }
  }

  return undefined;
}
