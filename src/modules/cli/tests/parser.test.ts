import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCli, runFixture } from "./support/cli";

test("the application registers mkdir in root help", async () => {
  const result = await runCli("--help");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("mkdir");
  expect(result.stderr).toBe("");
});

test("command help does not require positional input", async () => {
  const result = await runCli("mkdir", "--help");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("USAGE:\n  eden mkdir <OPTIONS> <path>");
  expect(result.stderr).toBe("");
});

test("routes positional input to the command", async () => {
  const result = await runFixture("echo", "hello");

  expect(result).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "" });
});

test.each([
  ["before", ["--json", "echo", "hello"]],
  ["after", ["echo", "hello", "--json"]],
] as const)("accepts the global JSON flag %s the command", async (_placement, argv) => {
  const result = await runFixture(...argv);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ value: "hello", dryRun: false });
  expect(result.stderr).toBe("");
});

test("CLI mkdir dry-run reports its plan without creating the directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "not-created");
    const result = await runCli("mkdir", path, "--dry-run", "--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      operations: [{ type: "fs.mkdir", input: { path } }],
    });
  });
});
