import { expect, spyOn, test } from "bun:test";
import { homedir } from "node:os";
import { parseFixture } from "./support/parser";

test("focused parser tests do not spawn processes or emulate environment and cwd", async () => {
  const previous = {
    cwd: process.cwd(),
    env: { ...process.env },
    argv: process.argv,
    home: homedir(),
  };
  const spawn = spyOn(Bun, "spawn");

  try {
    const result = await parseFixture("echo", "direct", "--json");

    expect(result).toEqual({
      exitCode: 0,
      stdout: '{"value":"direct","ok":true,"dryRun":false}\n',
      stderr: "",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(previous.cwd);
    expect(process.env).toEqual(previous.env);
    expect(process.argv).toBe(previous.argv);
    expect(homedir()).toBe(previous.home);
  } finally {
    spawn.mockRestore();
  }
});

test("focused parser output capture includes console help and restores output methods", async () => {
  const previous = {
    log: console.log,
    error: console.error,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };

  const result = await parseFixture("echo", "--help");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("USAGE:\n  eden echo <OPTIONS> <value>");
  expect(result.stderr).toBe("");
  expect(console.log).toBe(previous.log);
  expect(console.error).toBe(previous.error);
  expect(process.stdout.write).toBe(previous.stdout);
  expect(process.stderr.write).toBe(previous.stderr);
});

test("focused parser failures do not leak exit status into subsequent invocations", async () => {
  const exitCode = process.exitCode;

  const failed = await parseFixture("uncoded-failure", "--json");
  const succeeded = await parseFixture("silent", "--json");

  expect(failed.exitCode).toBe(1);
  expect(succeeded).toEqual({ exitCode: 0, stdout: '{"ok":true,"dryRun":false}\n', stderr: "" });
  expect(process.exitCode).toBe(exitCode);
});
