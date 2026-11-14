import { constants } from "node:os";
import type { ExecSandboxInput } from "../../modules/sandbox/provider";
import { SandboxError } from "../../modules/sandbox/errors";
import { saveTerminal, type TerminalSaver } from "./terminal";

export type AttachDependencies = {
  saveTerminal?: TerminalSaver;
  spawn?: (name: string) => ReturnType<typeof Bun.spawn>;
  platform?: NodeJS.Platform;
  isTerminal?: boolean;
  killGraceMs?: number;
};

export async function attachDockerSandbox(
  name: string,
  dependencies: AttachDependencies = {},
): Promise<number> {
  const platform = dependencies.platform ?? process.platform;
  const isTerminal = dependencies.isTerminal ?? process.stdin.isTTY;
  let restoreTerminal: (() => void) | undefined;
  if (isTerminal) {
    const captureTerminal = dependencies.saveTerminal ?? (() => saveTerminal(platform));
    restoreTerminal = captureTerminal();
  }

  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = (dependencies.spawn ?? spawnDockerAttach)(name);
  } catch {
    restoreTerminal?.();

    throw new SandboxError(
      "SANDBOX_PROVIDER_UNAVAILABLE",
      "Could not start Docker Sandboxes. Install sbx and ensure it is available on PATH.",
    );
  }

  let cancellationExitCode: number | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (signal: "SIGINT" | "SIGTERM") => {
    if (cancellationExitCode !== undefined) return;

    cancellationExitCode = 128 + constants.signals[signal];
    const handlesInterruptNatively = platform === "win32" && signal === "SIGINT";
    if (!handlesInterruptNatively) child.kill(signal);
    killTimer = setTimeout(() => child.kill("SIGKILL"), dependencies.killGraceMs ?? 1000);
    killTimer.unref();
  };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  try {
    const exitCode = await child.exited;

    return cancellationExitCode ?? exitCode;
  } finally {
    clearTimeout(killTimer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    restoreTerminal?.();
  }
}

function spawnDockerAttach(name: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["sbx", "run", "--name", name], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

export function attachDockerExec(input: ExecSandboxInput): Promise<number> {
  return attachDockerSandbox(input.name, {
    spawn: () =>
      Bun.spawn(["sbx", "exec", "-i", "--", input.name, ...input.argv], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
  });
}
