import * as v from "valibot";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { sandboxProviderNames } from "../sandbox/provider";

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

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());
const kitArgumentSchema = v.union([v.string(), v.number(), v.boolean()]);
const profileSchema = v.pipe(
  mapping,
  v.strictObject({
    provider: v.optional(v.picklist(sandboxProviderNames)),
    template: v.optional(nonEmptyString),
    kits: v.optional(v.array(nonEmptyString)),
    kit_args: v.optional(configMap(kitArgumentSchema)),
  }),
);

export const ConfigSchema = v.pipe(
  mapping,
  v.strictObject(
    {
      agent: v.optional(agentSchema),
      sandbox: v.optional(
        v.strictObject({
          default_provider: v.optional(v.picklist(sandboxProviderNames)),
          profiles: v.optional(configMap(profileSchema)),
        }),
      ),
      worktree_root: v.optional(worktreeRootSchema, () => join(homedir(), ".worktrees")),
    },
    "Expected a configuration object containing only recognized settings",
  ),
);

export type Config = v.InferOutput<typeof ConfigSchema>;
export type SandboxProfile = v.InferOutput<typeof profileSchema>;

function configMap<T extends v.GenericSchema>(value: T) {
  const schema = v.pipe(
    v.custom<Record<string, v.InferOutput<T>>>(
      (input) => typeof input === "object" && input !== null && !Array.isArray(input),
      "Expected a configuration mapping",
    ),
    v.rawCheck(({ dataset, addIssue }) => {
      if (!dataset.typed) return;

      for (const [key, input] of Object.entries(dataset.value)) {
        const path = [
          { type: "object", origin: "value", input: dataset.value, key, value: input },
        ] as const;

        if (key.length === 0) addIssue({ message: "Expected a non-empty key", path: [...path] });

        const result = v.safeParse(value, input);

        if (!result.success) {
          for (const issue of result.issues) {
            addIssue({ message: issue.message, path: [...path, ...(issue.path ?? [])] });
          }
        }
      }
    }),
  );

  return Object.assign(schema, { key: nonEmptyString, value });
}
