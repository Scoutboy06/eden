import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

export type SandboxdLinkProbe = {
  platform: string;
  env: Record<string, string | undefined>;
  readText: (path: string) => string | undefined;
  exists: (path: string) => boolean;
};

export type MissingSandboxdLinks = {
  links: string[];
  stateDir: string;
  temp: string | undefined;
};

const LOG_TAIL_LINES = 200;
const LOG_TAIL_BYTES = 256 * 1024;
const MISSING_ROOTFS = /rootfs disk does not exist: (.+?\\sboxd-[0-9a-f]+)\\/g;

export function defaultSandboxdLinkProbe(): SandboxdLinkProbe {
  return {
    platform: process.platform,
    env: process.env,
    readText: readFileTail,
    exists: existsSync,
  };
}

function sandboxdStateDir(env: Record<string, string | undefined>): string | undefined {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  return `${localAppData}\\DockerSandboxes\\sandboxes\\state\\sandboxd`;
}

function missingRootfsLinks(logText: string, exists: (path: string) => boolean): string[] {
  const links = new Set<string>();
  for (const match of logText.matchAll(MISSING_ROOTFS)) links.add(match[1]!);
  return [...links].filter((link) => !exists(link));
}

export function findMissingSandboxdLinks(
  probe: SandboxdLinkProbe,
): MissingSandboxdLinks | undefined {
  if (probe.platform !== "win32") return undefined;
  const stateDir = sandboxdStateDir(probe.env);
  if (stateDir === undefined) return undefined;
  const logText = probe.readText(`${stateDir}\\daemon.log`);
  if (logText === undefined) return undefined;
  const links = missingRootfsLinks(lastLines(logText, LOG_TAIL_LINES), probe.exists);
  if (links.length === 0) return undefined;
  return { links, stateDir, temp: probe.env.TEMP ?? probe.env.TMP };
}

export function sandboxdLinkRepairCommand(link: string, stateDir: string): string {
  return `New-Item -ItemType Junction -Path "${link}" -Target "${stateDir}"`;
}

function lastLines(text: string, count: number): string {
  return text.split(/\r?\n/).slice(-count).join("\n");
}

function readFileTail(path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const { size } = fstatSync(descriptor);
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
