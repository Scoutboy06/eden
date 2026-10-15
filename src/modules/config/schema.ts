import * as v from "valibot";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

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

const worktreeRootSchema = v.pipe(
  v.string(),
  v.check((path) => !path.includes("\0"), "Expected a path without null bytes"),
  v.transform((path) =>
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path,
  ),
  v.check(isAbsolute, "Expected an absolute path or a path starting with ~/"),
  v.transform(normalize),
);

export const ConfigSchema = v.pipe(
  mapping,
  v.strictObject(
    {
      agent: v.optional(agentSchema),
      worktree_root: v.optional(worktreeRootSchema, () => join(homedir(), ".worktrees")),
    },
    "Expected a configuration object containing only recognized settings",
  ),
);

export type Config = v.InferOutput<typeof ConfigSchema>;
