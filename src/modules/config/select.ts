import type * as v from "valibot";
import { ConfigSchema, type Config } from "./schema";

export function selectConfig(config: Config, path?: string): unknown {
  if (path === undefined) return config;

  let schema: v.GenericSchema = ConfigSchema;
  let value: unknown = config;

  for (const key of path.split(".")) {
    const entries = schemaEntries(schema);

    if (!entries || !Object.hasOwn(entries, key)) {
      throw Object.assign(new Error(`Unknown configuration key: ${path}`), {
        code: "CONFIG_KEY_UNKNOWN",
      });
    }

    schema = entries[key]!;
    value = value === undefined ? undefined : (value as Record<string, unknown>)[key];
  }

  return value;
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
