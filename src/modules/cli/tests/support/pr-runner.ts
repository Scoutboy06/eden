import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/pr.ts", import.meta.url));

export async function runPr(...args: string[]) {
  return runPrWithEnv({}, ...args);
}

export async function runPrWithEnv(env: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, fixture, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_TOKEN: "fake-test-token", ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}
