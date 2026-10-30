import { readFile } from "node:fs/promises";

export async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    const text = await Bun.file(path)
      .text()
      .catch(() => "");
    const pid = Number(text);
    if (pid > 0) return pid;

    await Bun.sleep(10);
  }

  throw new Error(`Process did not become ready: ${path}`);
}

export async function isRunning(pid: number): Promise<boolean> {
  if (process.platform === "win32") return isAlive(pid);

  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");

    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;

    throw error;
  }
}

export async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 1000;

  while ((await isRunning(pid)) && Date.now() < deadline) await Bun.sleep(10);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;

    throw error;
  }
}
