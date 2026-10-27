import { expect, test } from "bun:test";
import { chmod, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { isRunning, waitForExit, waitForPid } from "../../script/tests/support/process";

for (const operation of ["create", "stop", "readiness"] as const) {
  test.each(["ignore", "descendant"])(
    `${operation} cancellation terminates an uncooperative %s process group`,
    async (mode) => {
      await withTemporaryDirectory(async (directory) => {
        const { child, result, ready } = await startProvider(directory, operation, mode);
        const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
        let pid: number | undefined;

        try {
          pid = await waitForPid(ready);

          child.kill(operation === "readiness" ? "SIGUSR1" : "SIGINT");
          const response = await result;
          await waitForExit(pid);

          expect(response.exitCode).toBe(0);
          expect(response.stderr).toBe("");
          expect(JSON.parse(response.stdout)).toMatchObject({
            error: { code: "CANCELLED" },
            interruptListeners: 0,
            abortListeners: 0,
          });
          if (operation === "create") {
            expect(JSON.parse(response.stdout).error.message).toContain(
              "Sandbox test may already exist; no cleanup was attempted.",
            );
          }
          if (operation === "stop") {
            expect(JSON.parse(response.stdout).error.message).toContain(
              "It may already be stopped; no removal or cleanup was attempted.",
            );
          }
          expect(await isRunning(pid)).toBe(false);
        } finally {
          clearTimeout(deadline);
          if (pid && (await isRunning(pid))) process.kill(pid, "SIGKILL");
          if (child.exitCode === null) child.kill("SIGKILL");
          await result;
        }
      });
    },
  );
}

test.each(["success", "failure"])(
  "real provider execution preserves output, diagnostics, and listener cleanup on %s",
  async (mode) => {
    await withTemporaryDirectory(async (directory) => {
      const { result } = await startProvider(directory, "create", mode);

      const response = await result;
      const data = JSON.parse(response.stdout);

      expect(response.exitCode).toBe(0);
      expect(response.stderr).toBe("");
      expect(data).toMatchObject({
        output: "provider stdout\n",
        interruptListeners: 0,
        abortListeners: 0,
      });
      if (mode === "success") expect(data.error).toBeUndefined();
      else {
        expect(data.error.code).toBe("SANDBOX_CREATE_FAILED");
        expect(data.error.message).toContain("exit 7");
        expect(data.error.message).toContain("provider stdout");
        expect(data.error.message).toContain("provider stderr");
      }
    });
  },
);

async function startProvider(directory: string, operation: string, mode: string) {
  const executable = join(directory, "sbx");
  const ready = join(directory, "ready");
  await copyFile(new URL("./fixtures/sbx.ts", import.meta.url), executable);
  await chmod(executable, 0o755);
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./fixtures/lifecycle.ts", import.meta.url)),
      operation,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH}`,
        EDEN_SBX_TEST_MODE: mode,
        EDEN_SBX_TEST_READY: ready,
      },
    },
  );
  const result = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));

  return { child, result, ready };
}
