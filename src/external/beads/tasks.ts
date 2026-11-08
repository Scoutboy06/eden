import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as v from "valibot";

const taskSchema = v.object({
  id: v.string(),
  title: v.string(),
  status: v.string(),
  issue_type: v.string(),
  priority: v.union([v.literal(0), v.literal(1), v.literal(2), v.literal(3), v.literal(4)]),
  assignee: v.optional(v.string()),
  labels: v.optional(v.array(v.string())),
  updated_at: v.optional(v.string()),
  comment_count: v.optional(v.number()),
});

export type BeadsTask = v.InferOutput<typeof taskSchema>;

const execute = promisify(execFile);

export async function listBeadsTasks(cwd: string): Promise<BeadsTask[]> {
  let stdout: string;

  try {
    ({ stdout } = await execute(
      "bd",
      ["--readonly", "--no-color", "list", "--all", "--limit", "0", "--sort", "priority", "--json"],
      { cwd, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
    ));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new Error("Beads is not installed. Install bd and configure this checkout.");
    throw new Error(
      "Could not read Beads tasks. Check bd configuration and database connectivity in this checkout.",
    );
  }

  return parseBeadsTasks(stdout);
}

export function parseBeadsTasks(json: string): BeadsTask[] {
  try {
    return v.parse(v.array(taskSchema), JSON.parse(json));
  } catch {
    throw new Error("Beads returned an invalid task list.");
  }
}
