export type RunOptions = {
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  killGraceMs?: number;
};

export type RunResult = { stdout: string; stderr: string } & (
  | { outcome: "exited"; exitCode: number }
  | { outcome: "signaled"; signal: string }
  | { outcome: "timeout" }
  | { outcome: "cancelled" }
);

export class ScriptRunner {
  static async run(
    executable: string,
    input?: string | null,
    options?: RunOptions | null,
  ): Promise<RunResult> {
    const { args = [], cwd, env, timeoutMs, signal, killGraceMs = 1000 } = options ?? {};

    if (signal?.aborted) return { outcome: "cancelled", stdout: "", stderr: "" };

    const child = Bun.spawn([executable, ...args], {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdin: Buffer.from(input ?? ""),
      stdout: "pipe",
      stderr: "pipe",
    });
    let outcome: "timeout" | "cancelled" | undefined;
    let termination: Promise<void> | undefined;
    const terminate = (reason: "timeout" | "cancelled") => {
      if (outcome) return;

      outcome = reason;
      termination = terminateGroup(child.pid, killGraceMs);
    };
    const cancel = () => terminate("cancelled");
    const timeout =
      timeoutMs === undefined ? undefined : setTimeout(() => terminate("timeout"), timeoutMs);

    signal?.addEventListener("abort", cancel, { once: true });

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      if (termination) await termination;

      if (outcome) return { outcome, stdout, stderr };
      if (child.signalCode)
        return { outcome: "signaled", signal: child.signalCode, stdout, stderr };

      return { outcome: "exited", exitCode, stdout, stderr };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  }
}

async function terminateGroup(pid: number, graceMs: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  await Bun.sleep(graceMs);
  signalGroup(pid, "SIGKILL");
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
