import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withTemporaryDirectory } from "../../../modules/fs/tests/support/temporary-directory";

const adapter = new URL("../tasks.ts", import.meta.url).href;
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

async function runClient(cwd: string, path: string) {
  const child = Bun.spawn([process.execPath, "--eval", client], {
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
