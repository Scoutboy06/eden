import * as v from "valibot";

const AGENTS = ["codex", "claude", "opencode", "omp"] as const;

const mapping = v.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "Expected a configuration mapping",
);

const agentSchema = v.pipe(
  mapping,
  v.strictObject(
    {
      default: v.optional(v.picklist(AGENTS, "Expected codex, claude, or opencode")),
    },
    "Expected an agent object containing only recognized settings",
  ),
);

export const ConfigSchema = v.pipe(
  mapping,
  v.strictObject(
    { agent: v.optional(agentSchema) },
    "Expected a configuration object containing only recognized settings",
  ),
);

export type Config = v.InferOutput<typeof ConfigSchema>;
