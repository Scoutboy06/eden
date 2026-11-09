import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as v from "valibot";

import { taskSchema } from "./tasks";

const detailSchema = v.object({
  ...taskSchema.entries,
  description: v.optional(v.string(), ""),
  created_at: v.optional(v.string()),
});
const text = v.pipe(v.string(), v.maxLength(100_000));
const patchSchema = v.strictObject({
  title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))),
  description: v.optional(text),
  status: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
  priority: v.optional(taskSchema.entries.priority),
  assignee: v.optional(v.pipe(v.string(), v.maxLength(500))),
  labels: v.optional(
    v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.trim(),
          v.minLength(1),
          v.maxLength(100),
          v.check((label) => !label.includes(",") && !label.includes("\0")),
        ),
      ),
      v.maxLength(100),
    ),
  ),
});
const execute = promisify(execFile);

export type BeadsTaskDetail = v.InferOutput<typeof detailSchema>;
export type BeadsTaskPatch = v.InferOutput<typeof patchSchema>;

export async function getBeadsTask(cwd: string, id: string): Promise<BeadsTaskDetail> {
  validateTaskId(id);
  const output = await run(cwd, ["--readonly", "show", id, "--json"]);
  try {
    const tasks = v.parse(v.array(detailSchema), JSON.parse(output));
    if (tasks.length !== 1 || tasks[0]!.id !== id) throw new Error();
    return tasks[0]!;
  } catch {
    throw new Error("Beads returned invalid task details.");
  }
}

export function taskUpdateArguments(id: string, input: unknown): string[] {
  validateTaskId(id);
  const patch = v.safeParse(patchSchema, input);
  if (!patch.success || Object.keys(patch.output).length === 0)
    throw new Error("Invalid task changes. Check the editable fields.");
  const args = ["update", id];
  for (const [key, value] of Object.entries(patch.output)) {
    if (value === undefined) continue;
    args.push(
      `--${key === "labels" ? "set-labels" : key}`,
      Array.isArray(value) ? [...new Set(value)].join(",") : String(value),
    );
  }
  return args;
}

export async function updateBeadsTask(cwd: string, id: string, input: unknown) {
  const args = taskUpdateArguments(id, input);
  await run(cwd, args, true);
  try {
    return await getBeadsTask(cwd, id);
  } catch {
    throw new Error(
      "Changes were saved, but task details could not be reloaded. Refresh before retrying.",
    );
  }
}

export async function getBeadsStatuses(cwd: string): Promise<string[]> {
  const output = await run(cwd, ["--readonly", "statuses", "--json"]);
  try {
    const schema = v.object({
      built_in_statuses: v.array(v.object({ name: v.string() })),
      custom_statuses: v.optional(v.array(v.object({ name: v.string() })), []),
    });
    const parsed = v.parse(schema, JSON.parse(output));
    return [...parsed.built_in_statuses, ...parsed.custom_statuses].map((status) => status.name);
  } catch {
    throw new Error("Could not read configured Beads statuses.");
  }
}

function validateTaskId(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id)) throw new Error("Invalid task ID.");
}

async function run(cwd: string, args: string[], mutation = false) {
  try {
    const { stdout } = await execute("bd", ["--no-color", ...args], {
      cwd,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  } catch {
    throw new Error(
      mutation
        ? "Could not confirm the Beads update. Check connectivity and refresh before retrying; changes may have applied."
        : "Could not read this Beads task. It may be missing or the provider may be unavailable.",
    );
  }
}
