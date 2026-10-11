import { expect, test } from "bun:test";
import { runFixture } from "./support/cli";

test("human validation errors include command usage", async () => {
  const result = await runFixture("echo");

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toStartWith("Positional argument 'value' is required\n\n");
  expect(result.stderr).toContain("USAGE:\n  eden echo <OPTIONS> <value>");
});

test("human validation errors contain neither ANSI coloring nor a stack trace", async () => {
  const result = await runFixture("echo");

  expect(result.stderr).not.toContain("\u001b");
  expect(result.stderr).not.toContain("at ");
});

test("JSON validation errors contain only the structured error", async () => {
  const result = await runFixture("echo", "--json");

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: `${JSON.stringify({
      error: {
        code: "err:arg:required-positional",
        message: "Positional argument 'value' is required",
      },
    })}\n`,
  });
});

test("unknown commands have a distinct error code", async () => {
  const result = await runFixture("missing-command", "--json");

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error.code).toBe("err:cmd:not-found");
});

test("multiple validation errors are combined into one JSON error", async () => {
  const result = await runFixture("two-required-options", "--json");

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({
    error: {
      code: "VALIDATION_ERROR",
      message: "Optional argument '--first' is required\nOptional argument '--second' is required",
    },
  });
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
});

test("human execution errors contain only the message", async () => {
  const result = await runFixture("uncoded-failure");

  expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "Something failed\n" });
});

test("JSON execution errors preserve native error codes", async () => {
  const result = await runFixture("coded-failure", "--json");

  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":{"code":"EACCES","message":"Access denied"}}\n',
  });
});

test("JSON execution errors without a native code use COMMAND_FAILED", async () => {
  const result = await runFixture("uncoded-failure", "--json");

  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: "COMMAND_FAILED", message: "Something failed" },
  });
});

test("empty aggregate errors preserve their own message in human mode", async () => {
  const result = await runFixture("empty-aggregate");

  expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "Empty aggregate\n" });
});

test("empty aggregate errors preserve their own message in JSON mode", async () => {
  const result = await runFixture("empty-aggregate", "--json");

  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: "COMMAND_FAILED", message: "Empty aggregate" },
  });
});

test("single-error aggregates preserve the underlying code and message", async () => {
  const result = await runFixture("single-aggregate", "--json");

  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: "EACCES", message: "Access denied" },
  });
});

test("command-loading failures are reported exactly once without usage", async () => {
  const result = await runFixture("loading-failure");

  expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "Loading failed\n" });
});
