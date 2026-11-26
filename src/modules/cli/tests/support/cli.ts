import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectProcess } from "./collect-process";

const interruptPreload = fileURLToPath(new URL("./interrupt-preload.ts", import.meta.url));
const application = fileURLToPath(new URL("../../../../../apps/cli/src/main.ts", import.meta.url));

export type CliOptions = { cwd: string; env?: Record<string, string | undefined> };

export async function withRunningCli<T>(
  options: CliOptions,
  argv: string[],
  action: (cli: {
    result: Promise<{ exitCode: number; stdout: string; stderr: string }>;
    interrupt(): void;
    waitForReady(path: string): Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const trigger = join(tmpdir(), `eden-interrupt-${crypto.randomUUID()}`);
  const windows = process.platform === "win32";
  const child = spawn(
    application,
    argv,
    windows ? { ...options, env: { ...options.env, EDEN_TEST_INTERRUPT_FILE: trigger } } : options,
    windows ? ["--preload", interruptPreload] : [],
  );
  const result = collectProcess(child);

  try {
    return await action({
      result,
      interrupt: () => {
        if (windows) writeFileSync(trigger, "");
        else child.kill("SIGINT");
      },
      async waitForReady(path) {
        const deadline = Date.now() + 3000;
        while (!(await Bun.file(path).exists())) {
          if (child.exitCode !== null) throw new Error((await result).stdout);
          if (Date.now() >= deadline) throw new Error("CLI hook readiness timed out");
          await Bun.sleep(10);
        }
      },
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await result;
    rmSync(trigger, { force: true });
  }
}

export function runCli(...argv: string[]) {
  return execute(application, argv);
}

export function runCliWith(
  options: { cwd: string; env?: Record<string, string | undefined> },
  ...argv: string[]
) {
  return execute(application, argv, options);
}

async function execute(
  entry: string,
  argv: string[],
  options?: { cwd: string; env?: Record<string, string | undefined> },
) {
  return collectProcess(spawn(entry, argv, options));
}

function spawn(entry: string, argv: string[], options?: CliOptions, runtimeArgs: string[] = []) {
  return Bun.spawn([process.execPath, ...runtimeArgs, entry, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: options?.cwd,
    env: { ...process.env, FORCE_COLOR: "1", ...options?.env },
  });
}
