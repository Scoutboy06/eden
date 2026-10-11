import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../../../../apps/cli/src/main.ts", import.meta.url));

async function invoke(...argv: string[]) {
  return execute(main, ...argv);
}

async function invokeFixture(command: string, ...argv: string[]) {
  const fixture = join(directory, "fixture.ts");
  await Bun.write(
    fixture,
    `import { runCli } from ${JSON.stringify(new URL("../parser.ts", import.meta.url).href)};
import { lazy } from ${JSON.stringify(import.meta.resolve("gunshi"))};
await runCli({ fixture: ${command} });`,
  );
  return execute(fixture, "fixture", ...argv);
}

async function execute(entry: string, ...argv: string[]) {
  const child = Bun.spawn([process.execPath, entry, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "eden-cli-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("renders human validation errors and usage only on stderr without color or a stack trace", async () => {
  const result = await invoke("mkdir");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toStartWith("Positional argument 'path' is required\n\n");
  expect(result.stderr).toContain("USAGE:\n  eden mkdir <OPTIONS> <path>");
  expect(result.stderr).not.toContain("\u001b");
  expect(result.stderr).not.toContain("at ");
});

for (const argv of [
  ["--json", "mkdir"],
  ["mkdir", "--json"],
]) {
  test(`renders JSON validation errors for ${argv.join(" ")}`, async () => {
    const result = await invoke(...argv);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "err:arg:required-positional",
        message: "Positional argument 'path' is required",
      },
    });
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
  });
}

test("renders an unknown command as a JSON error", async () => {
  const result = await invoke("missing-command", "--json");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error.code).toBe("err:cmd:not-found");
});

for (const json of [false, true]) {
  test(`catches execution failures in ${json ? "JSON" : "human"} mode`, async () => {
    const path = join(directory, "existing-file");
    await Bun.write(path, "unchanged");
    const result = await invoke("mkdir", path, ...(json ? ["--json"] : []));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("\u001b");
    if (json) {
      const failure = JSON.parse(result.stderr);
      expect(failure.error.code).toBe("EEXIST");
      expect(failure.error.message).toContain("EEXIST");
      expect(Object.keys(failure)).toEqual(["error"]);
    } else {
      expect(result.stderr).toContain("EEXIST");
      expect(result.stderr).not.toContain("USAGE:");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
    }
    expect(await Bun.file(path).text()).toBe("unchanged");
  });
}

test("keeps success JSON unchanged and performs normal mutations", async () => {
  const path = join(directory, "created");
  const result = await invoke("mkdir", path, "--json");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    dryRun: false,
    operations: [{ type: "fs.mkdir", description: `Create directory ${path}`, input: { path } }],
  });
  expect((await stat(path)).isDirectory()).toBe(true);
});

test("keeps dry-run JSON unchanged without performing mutations", async () => {
  const path = join(directory, "not-created");
  const result = await invoke("mkdir", path, "--dry-run", "--json");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    dryRun: true,
    operations: [{ type: "fs.mkdir", description: `Create directory ${path}`, input: { path } }],
  });
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("continues to render help on stdout without validating required input", async () => {
  const result = await invoke("mkdir", "--help");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Create a directory");
  expect(result.stderr).toBe("");
});

test("combines multiple validation errors into one JSON object", async () => {
  const result = await invokeFixture(
    `{
      name: "fixture",
      args: {
        first: { type: "string", required: true },
        second: { type: "string", required: true },
      },
      run() { throw new Error("Validation should prevent execution"); },
    }`,
    "--json",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  const failure = JSON.parse(result.stderr);
  expect(failure.error.code).toBe("VALIDATION_ERROR");
  expect(failure.error.message.split("\n")).toEqual([
    "Optional argument '--first' is required",
    "Optional argument '--second' is required",
  ]);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
});

for (const json of [false, true]) {
  for (const [expression, message] of [
    ['new AggregateError([], "Empty aggregate")', "Empty aggregate"],
    ['new Error("No native code")', "No native code"],
  ]) {
    test(`handles ${message} in ${json ? "JSON" : "human"} mode`, async () => {
      const result = await invokeFixture(
        `{ name: "fixture", run() { throw ${expression}; } }`,
        ...(json ? ["--json"] : []),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        json
          ? `${JSON.stringify({ error: { code: "COMMAND_FAILED", message } })}\n`
          : `${message}\n`,
      );
    });
  }
}

test("catches command-loading errors before context exists exactly once", async () => {
  const result = await invokeFixture('lazy(() => { throw new Error("Loading failed"); })');
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Loading failed\n");
});
