import { spyOn } from "bun:test";
import { format } from "node:util";

export async function captureOutput(run: () => void | Promise<void>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  const logSpy = spyOn(console, "log").mockImplementation((...args) => {
    stdout.push(`${format(...args)}\n`);
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args) => {
    stderr.push(`${format(...args)}\n`);
  });

  try {
    await run();
    return { stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}
