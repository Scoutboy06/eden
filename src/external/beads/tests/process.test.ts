import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withTemporaryDirectory } from "../../../modules/fs/tests/support/temporary-directory";

const adapter = new URL("../tasks.ts", import.meta.url).href;
const detailAdapter = new URL("../task-detail.ts", import.meta.url).href;
const client = `
  const { listBeadsTasks } = await import(${JSON.stringify(adapter)});
  try {
    console.log(JSON.stringify(await listBeadsTasks(process.cwd())));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
`;

test.skipIf(process.platform === "win32")(
  "invokes bd read-only, unbounded and in the checkout (POSIX executable fixture)",
  async () => {
    await withTemporaryDirectory(async (directory) => {
      await writeFile(
        join(directory, "bd"),
        `#!${process.execPath}
await Bun.write("invocation.json", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
console.log("[]");
`,
        { mode: 0o755 },
      );

      const result = await runClient(directory, directory);

      expect(result).toEqual({ code: 0, stdout: "[]\n", stderr: "" });
      expect(JSON.parse(await readFile(join(directory, "invocation.json"), "utf8"))).toEqual({
        cwd: directory,
        args: [
          "--readonly",
          "--no-color",
          "list",
          "--all",
          "--limit",
          "0",
          "--sort",
          "priority",
          "--json",
        ],
      });
    });
  },
);

test.skipIf(process.platform === "win32")(
  "reports missing bd and redacts failed command output (POSIX executable fixture)",
  async () => {
    await withTemporaryDirectory(async (directory) => {
      const missing = await runClient(directory, directory);
      await writeFile(
        join(directory, "bd"),
        `#!${process.execPath}
console.error("password=secret");
process.exitCode = 1;
`,
        { mode: 0o755 },
      );

      const failed = await runClient(directory, directory);

      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("Beads is not installed.");
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("Check bd configuration and database connectivity");
      expect(failed.stderr).not.toContain("secret");
    });
  },
);

test.skipIf(process.platform === "win32")(
  "detail reads and writes use exact targets, checkout configuration and redacted failures (POSIX executable fixture)",
  async () => {
    await withTemporaryDirectory(async (directory) => {
      const task = {
        id: "eden-1",
        title: "Title",
        description: "Body",
        issue_type: "task",
        status: "open",
        priority: 2,
      };
      await writeFile(
        join(directory, "bd"),
        `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
if (args.includes("update")) console.log("updated");
else if (args.includes("statuses")) console.log(JSON.stringify({ built_in_statuses: [{ name: "open" }], custom_statuses: [{ name: "review" }] }));
else console.log(${JSON.stringify(JSON.stringify([task]))});
`,
        { mode: 0o755 },
      );
      const script = `
const { getBeadsTask, getBeadsStatuses, updateBeadsTask } = await import(${JSON.stringify(detailAdapter)});
const cwd = process.cwd();
const task = await getBeadsTask(cwd, "eden-1");
const statuses = await getBeadsStatuses(cwd);
const updated = await updateBeadsTask(cwd, "eden-1", { assignee: "", labels: [] });
console.log(JSON.stringify({ task, statuses, updated }));
`;

      const result = await runClient(directory, directory, script);
      const output = JSON.parse(result.stdout);
      const recordedCalls = await readFile(join(directory, "calls.jsonl"), "utf8");
      const calls = recordedCalls
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const checkouts = [...new Set(calls.map((call) => call.cwd))];
      const argumentsByCall = calls.map((call) => call.args);

      expect(result.code).toBe(0);
      expect(output).toEqual({ task, statuses: ["open", "review"], updated: task });
      expect(checkouts).toEqual([directory]);
      expect(argumentsByCall).toEqual([
        ["--no-color", "--readonly", "show", "eden-1", "--json"],
        ["--no-color", "--readonly", "statuses", "--json"],
        ["--no-color", "update", "eden-1", "--assignee", "", "--set-labels", ""],
        ["--no-color", "--readonly", "show", "eden-1", "--json"],
      ]);
    });
  },
);

test.skipIf(process.platform === "win32")(
  "failed detail updates redact provider diagnostics (POSIX executable fixture)",
  async () => {
    await withTemporaryDirectory(async (directory) => {
      const provider = `#!${process.execPath}
console.error("password=secret");
process.exitCode = 1;
`;
      const script = `
const { updateBeadsTask } = await import(${JSON.stringify(detailAdapter)});
try {
  await updateBeadsTask(process.cwd(), "eden-1", { title: "Updated" });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`;
      await writeFile(join(directory, "bd"), provider, { mode: 0o755 });

      const result = await runClient(directory, directory, script);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("changes may have applied");
      expect(result.stderr).not.toContain("secret");
    });
  },
);

async function runClient(cwd: string, path: string, script = client) {
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd,
    env: { ...process.env, PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, stdout, stderr };
}
