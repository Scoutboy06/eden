import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import type { SandboxDoctorLink, SandboxDoctorReport } from "../../modules/sandbox/provider";

export type SandboxdLinkProbe = {
  platform: string;
  env: Record<string, string | undefined>;
  readText: (path: string) => string | undefined;
  exists: (path: string) => boolean;
  readLink: (path: string) => string | undefined;
  readDir: (path: string) => string[];
  realPath?: (path: string) => string;
  createJunction: (path: string, target: string) => void;
};

export type MissingSandboxdLinks = {
  links: string[];
  stateDir: string;
  temp: string | undefined;
};

const LOG_TAIL_LINES = 200;
const LOG_TAIL_BYTES = 256 * 1024;
const MISSING_ROOTFS = /rootfs disk does not exist: (.+?\\sboxd-[0-9a-f]+)\\/g;
const LINK_NAME_PREFIX = "sboxd-";
const NUMERIC_FOLDER = /^\d+$/;

export function defaultSandboxdLinkProbe(): SandboxdLinkProbe {
  return {
    platform: process.platform,
    env: process.env,
    readText: readFileTail,
    exists: existsSync,
    readLink: readLinkTarget,
    readDir: readDirNames,
    realPath: resolveRealPath,
    createJunction: (path, target) => symlinkSync(target, path, "junction"),
  };
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

export function diagnoseSandboxdLinks(
  probe: SandboxdLinkProbe,
  options: { fix: boolean },
): SandboxDoctorReport {
  const stateDir = sandboxdStateDir(probe.env);
  if (probe.platform !== "win32" || stateDir === undefined) {
    return { applicable: false, links: [] };
  }
  const temp = probe.env.TEMP ?? probe.env.TMP;
  const logText = probe.readText(`${stateDir}\\daemon.log`);
  const logLinks = logText === undefined ? [] : rootfsLinkPaths(lastLines(logText, LOG_TAIL_LINES));
  const links = linkPaths(probe, stateDir, temp, logLinks).map((path) =>
    inspectLink(probe, path, stateDir),
  );

  return {
    applicable: true,
    stateDir,
    temp,
    links: options.fix ? links.map((link) => repairLink(probe, link, stateDir)) : links,
  };
}

export function sandboxdLinkRepairCommand(link: string, stateDir: string): string {
  return `New-Item -ItemType Junction -Path "${link}" -Target "${stateDir}"`;
}

export function sandboxdLogPath(
  platform: string,
  env: Record<string, string | undefined>,
): string | undefined {
  if (platform !== "win32") return undefined;
  const stateDir = sandboxdStateDir(env);
  return stateDir === undefined ? undefined : `${stateDir}\\daemon.log`;
}

function sandboxdStateDir(env: Record<string, string | undefined>): string | undefined {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  return `${localAppData}\\DockerSandboxes\\sandboxes\\state\\sandboxd`;
}

function rootfsLinkPaths(logText: string): string[] {
  const links = new Set<string>();
  for (const match of logText.matchAll(MISSING_ROOTFS)) links.add(match[1]!);
  return [...links];
}

function missingRootfsLinks(logText: string, exists: (path: string) => boolean): string[] {
  return rootfsLinkPaths(logText).filter((link) => !exists(link));
}

function linkPaths(
  probe: SandboxdLinkProbe,
  stateDir: string,
  temp: string | undefined,
  logLinks: string[],
): string[] {
  const base = `${probe.env.LOCALAPPDATA}\\Temp`;
  const directories = [
    base,
    ...probe
      .readDir(base)
      .filter((name) => NUMERIC_FOLDER.test(name))
      .map((name) => `${base}\\${name}`),
    ...(temp === undefined ? [] : [stripTrailingSeparators(temp)]),
  ];
  const names = new Set(logLinks.map(lastSegment));
  if (temp !== undefined) {
    for (const name of probe.readDir(temp)) {
      const candidate = `${stripTrailingSeparators(temp)}\\${name}`;
      if (name.startsWith(LINK_NAME_PREFIX) && pointsTo(probe.readLink(candidate), stateDir)) {
        names.add(name);
      }
    }
  }

  const paths = new Map<string, string>();
  const add = (path: string) => {
    const realPath = probe.realPath ?? ((directory: string) => directory);
    const key = normalizePath(`${realPath(parentOf(path))}\\${lastSegment(path)}`);
    if (!paths.has(key)) paths.set(key, path);
  };
  for (const directory of directories) for (const name of names) add(`${directory}\\${name}`);
  for (const link of logLinks) add(link);

  return [...paths.values()];
}

function inspectLink(probe: SandboxdLinkProbe, path: string, stateDir: string): SandboxDoctorLink {
  const actual = probe.readLink(path);
  if (actual === undefined) {
    return probe.exists(path)
      ? { path, status: "wrong-target", actual: "not a link" }
      : { path, status: "missing" };
  }

  return pointsTo(actual, stateDir)
    ? { path, status: "ok" }
    : { path, status: "wrong-target", actual };
}

function repairLink(
  probe: SandboxdLinkProbe,
  link: SandboxDoctorLink,
  stateDir: string,
): SandboxDoctorLink {
  if (link.status !== "missing") return link;
  try {
    probe.createJunction(link.path, stateDir);
    return { path: link.path, status: "created" };
  } catch (error) {
    return {
      path: link.path,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function pointsTo(actual: string | undefined, stateDir: string): boolean {
  return actual !== undefined && normalizePath(actual) === normalizePath(stateDir);
}

function normalizePath(path: string): string {
  return stripTrailingSeparators(path.replace(/^\\\\\?\\/, "").replaceAll("/", "\\")).toLowerCase();
}

function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("\\"));
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("\\") + 1);
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

function readLinkTarget(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

function resolveRealPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function readDirNames(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
