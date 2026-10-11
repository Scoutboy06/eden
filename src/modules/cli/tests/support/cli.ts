import { fileURLToPath } from "node:url";

const application = fileURLToPath(new URL("../../../../../apps/cli/src/main.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/main.ts", import.meta.url));

export function runCli(...argv: string[]) {
  return execute(application, argv);
}

export function runFixture(...argv: string[]) {
  return execute(fixture, argv);
}

async function execute(entry: string, argv: string[]) {
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
