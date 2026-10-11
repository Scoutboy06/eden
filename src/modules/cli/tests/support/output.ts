import { spyOn } from "bun:test";

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

  try {
    await run();
    return { stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}
