import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { ScriptRunner, type RunOptions, type RunResult } from "../index";
import { isRunning, waitForExit, waitForPid } from "./support/process";

const fixtures = join(import.meta.dir, "fixtures");
const fixture = (name: string) => join(fixtures, `${name}.ts`);

test("runs an executable Bun JSON hook while leaving serialization to its caller", async () => {
  const input = JSON.stringify({ name: "Eden" });

  const result: RunResult = await ScriptRunner.run(fixture("json-hook"), input);

  expect(result).toMatchObject({ outcome: "exited", exitCode: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({ success: true, message: "Hello Eden" });
});

test("passes arguments without shell interpretation and writes stdin verbatim", async () => {
  const input = " first line\n\nlast line \t\0".repeat(10000);
  const args = ["argument with spaces", "$(echo unsafe)", "*.ts", "; exit 9"];
  const options: RunOptions = { args };

  const result = await ScriptRunner.run(fixture("inspect"), input, options);

  expect(result).toMatchObject({ outcome: "exited", exitCode: 0 });
  expect(JSON.parse(result.stdout)).toMatchObject({ input, args });
});

test.each([undefined, null, ""])("closes stdin for input %p", async (input) => {
  const result = await ScriptRunner.run(fixture("inspect"), input);

  expect(result).toMatchObject({ outcome: "exited", exitCode: 0 });
  expect(JSON.parse(result.stdout)).toMatchObject({ input: "", cwd: process.cwd() });
});

test("accepts null options", async () => {
  const result = await ScriptRunner.run(fixture("inspect"), null, null);

  expect(result).toMatchObject({ outcome: "exited", exitCode: 0 });
  expect(JSON.parse(result.stdout).path).toBe(process.env.PATH);
});

test("resolves relative executables against cwd and merges environment overrides", async () => {
  const result = await ScriptRunner.run("./inspect.ts", undefined, {
    cwd: fixtures,
    env: { EDEN_SCRIPT_TEST: "overridden" },
  });

  expect(result).toMatchObject({ outcome: "exited", exitCode: 0 });
  expect(JSON.parse(result.stdout)).toMatchObject({
    cwd: fixtures,
    value: "overridden",
    path: process.env.PATH,
  });
});

test("searches bare executable names using the effective PATH", async () => {
  await withTemporaryDirectory(async (directory) => {
    await symlink(fixture("inspect"), join(directory, "eden-test-hook"));
    const path = `${directory}:${process.env.PATH}`;

    const result = await ScriptRunner.run("eden-test-hook", null, { env: { PATH: path } });

    expect(result).toMatchObject({ outcome: "exited", exitCode: 0 });
    expect(JSON.parse(result.stdout).path).toBe(path);
  });
});

test("captures stdout and stderr concurrently without truncating and returns nonzero exits", async () => {
  const result = await ScriptRunner.run(fixture("output"), null, { args: ["100000", "23"] });

  expect(result).toEqual({
    outcome: "exited",
    exitCode: 23,
    stdout: "out\n".repeat(100000),
    stderr: "err\n".repeat(100000),
  });
});

test("throws when the executable cannot be launched", async () => {
  await expect(ScriptRunner.run(join(fixtures, "missing.ts"))).rejects.toThrow();
});

test("delivers stderr while the process is running and also captures it", async () => {
  const controller = new AbortController();
  const chunks: string[] = [];
  const result = await ScriptRunner.run(fixture("stderr-ready"), null, {
    signal: controller.signal,
    timeoutMs: 3000,
    killGraceMs: 10,
    onStderr(text) {
      chunks.push(text);
      controller.abort();
    },
  });

  expect(result).toMatchObject({ outcome: "cancelled", stderr: "ready\n" });
  expect(chunks.join("")).toBe(result.stderr);
});

test("does not fall back to a shell for an executable without a shebang", async () => {
  await expect(ScriptRunner.run(fixture("no-shebang"))).rejects.toThrow();
});

test("preserves natural signal termination", async () => {
  const result = await ScriptRunner.run(fixture("signal"));

  expect(result).toEqual({ outcome: "signaled", signal: "SIGTERM", stdout: "", stderr: "" });
});

test("returns timeout after terminating the process", async () => {
  const result = await ScriptRunner.run(fixture("wait"), null, {
    timeoutMs: 200,
    killGraceMs: 20,
  });

  expect(result).toMatchObject({ outcome: "timeout", stderr: "" });
});

test("does not start an executable for a pre-aborted signal", async () => {
  const signal = AbortSignal.abort();

  const result = await ScriptRunner.run("does-not-exist", null, { signal });

  expect(result).toEqual({ outcome: "cancelled", stdout: "", stderr: "" });
});

test("removes the abort listener after normal completion", async () => {
  const controller = new AbortController();

  const result = await ScriptRunner.run(fixture("output"), null, {
    signal: controller.signal,
    timeoutMs: 4000,
  });

  expect(result).toMatchObject({ outcome: "exited", exitCode: 0 });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("cancels a running process", async () => {
  await withTemporaryDirectory(async (directory) => {
    const ready = join(directory, "ready");
    const controller = new AbortController();
    const run = ScriptRunner.run(fixture("wait"), null, {
      env: { EDEN_READY_FILE: ready },
      signal: controller.signal,
      timeoutMs: 4000,
      killGraceMs: 20,
    });

    try {
      const pid = await waitForPid(ready);
      controller.abort();
      const result = await run;

      expect(result).toEqual({ outcome: "cancelled", stdout: "ready\n", stderr: "" });
      expect(await isRunning(pid)).toBe(false);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      controller.abort();
      await run;
    }
  });
});

test("allows SIGTERM cleanup to finish during the grace period", async () => {
  await withTemporaryDirectory(async (directory) => {
    const ready = join(directory, "ready");
    const controller = new AbortController();
    const run = ScriptRunner.run(fixture("cleanup"), null, {
      env: { EDEN_READY_FILE: ready },
      signal: controller.signal,
      timeoutMs: 4000,
      killGraceMs: 500,
    });

    try {
      await waitForPid(ready);
      controller.abort();
      const result = await run;

      expect(result).toEqual({ outcome: "cancelled", stdout: "cleaned up\n", stderr: "" });
    } finally {
      controller.abort();
      await run;
    }
  });
});

test.each([false, true])(
  "terminates descendants after their parent exits with SIGTERM ignored: %p",
  async (ignoreTerm) => {
    await withTemporaryDirectory(async (directory) => {
      const ready = join(directory, "ready");
      const controller = new AbortController();
      const run = ScriptRunner.run(fixture("tree"), null, {
        env: { EDEN_READY_FILE: ready, EDEN_IGNORE_TERM: ignoreTerm ? "1" : "0" },
        signal: controller.signal,
        timeoutMs: 4000,
        killGraceMs: 50,
      });
      let pid: number | undefined;

      try {
        pid = await waitForPid(ready);
        controller.abort();
        const result = await run;
        await waitForExit(pid);

        expect(result).toMatchObject({ outcome: "cancelled" });
        expect(await isRunning(pid)).toBe(false);
      } finally {
        controller.abort();
        await run;
        if (pid && (await isRunning(pid))) process.kill(pid, "SIGKILL");
      }
    });
  },
);
