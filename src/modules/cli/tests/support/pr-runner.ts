import { fileURLToPath } from "node:url";
import { collectProcess } from "./collect-process";

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
  return collectProcess(child);
}
