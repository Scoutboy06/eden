import { fileURLToPath } from "node:url";

const application = fileURLToPath(new URL("../../../../../apps/cli/src/main.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/main.ts", import.meta.url));

type CliOptions = { cwd: string; env?: Record<string, string | undefined> };

export async function withRunningCli<T>(
  options: CliOptions,
  argv: string[],
  action: (cli: {
    result: Promise<{ exitCode: number; stdout: string; stderr: string }>;
    interrupt(): void;
    waitForReady(path: string): Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const child = spawn(application, argv, options);
  const result = collect(child);

  try {
    return await action({
      result,
      interrupt: () => child.kill("SIGINT"),
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

export function runFixture(...argv: string[]) {
  return execute(fixture, argv);
}

async function execute(
  entry: string,
  argv: string[],
  options?: { cwd: string; env?: Record<string, string | undefined> },
) {
  return collect(spawn(entry, argv, options));
}

function spawn(entry: string, argv: string[], options?: CliOptions) {
  return Bun.spawn([process.execPath, entry, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: options?.cwd,
    env: { ...process.env, FORCE_COLOR: "1", ...options?.env },
  });
}

async function collect(child: ReturnType<typeof spawn>) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
