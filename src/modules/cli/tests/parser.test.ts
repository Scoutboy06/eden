import { expect, test } from "bun:test";
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

test("exposes the dry-run flag through the command context", async () => {
  const result = await runFixture("echo", "hello", "--dry-run", "--json");

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ value: "hello", dryRun: true });
  expect(result.stderr).toBe("");
});
