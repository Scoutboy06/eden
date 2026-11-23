import { SandboxError } from "../../modules/sandbox/errors";
import type { SandboxDoctorLink, SandboxDoctorReport } from "../../modules/sandbox/provider";
import { defaultSandboxdLinkProbe, type SandboxdLinkProbe } from "./sandboxd-link-probe";

export type { SandboxdLinkProbe } from "./sandboxd-link-probe";

type MissingSandboxdLinks = {
  links: string[];
  stateDir: string;
  temp: string | undefined;
};

const LOG_TAIL_LINES = 200;
const MISSING_ROOTFS = /rootfs disk does not exist: (.+?\\sboxd-[0-9a-f]+)\\/g;
const LINK_NAME_PREFIX = "sboxd-";
const NUMERIC_FOLDER = /^\d+$/;

export class SandboxdLinks {
  constructor(private readonly probe: SandboxdLinkProbe = defaultSandboxdLinkProbe()) {}

  diagnose(options: { fix: boolean }): SandboxDoctorReport {
    const stateDir = this.stateDirectory();
    if (stateDir === undefined) {
      return { applicable: false, links: [] };
    }
    const temp = this.probe.env.TEMP ?? this.probe.env.TMP;
    const paths = this.linkPaths(stateDir, temp);
    const links = paths.map((path) => this.inspectLink(path, stateDir));

    return {
      applicable: true,
      stateDir,
      temp,
      links: options.fix ? links.map((link) => this.repairLink(link, stateDir)) : links,
    };
  }

  logPath(): string | undefined {
    const stateDir = this.stateDirectory();
    return stateDir === undefined ? undefined : `${stateDir}\\daemon.log`;
  }

  startFailure(name: string, exitCode: number, diagnostics: string): SandboxError | undefined {
    const missing = this.findMissingLinks();
    if (missing === undefined) return undefined;
    const details = diagnostics.trim();
    const logPath = this.logPath();
    const lines = [
      `Docker Sandboxes could not start sandbox ${name} (exit ${exitCode}) because sandboxd's temp link is missing. No retry or cleanup was attempted.`,
      "",
      "Missing link:",
      ...missing.links.map((link) => `  ${link}`),
      "",
      `Current TEMP: ${missing.temp ?? "unknown"}`,
      `It should point to: ${missing.stateDir}`,
      "",
      "Recreate it with: eden sbx doctor --fix",
      "Or in PowerShell:",
      ...missing.links.map((link) => `  ${sandboxdLinkRepairCommand(link, missing.stateDir)}`),
      ...(details ? ["", "Docker Sandboxes reported:", details] : []),
      ...(details && logPath ? [`Docker Sandboxes log: ${logPath}`] : []),
    ];
    return new SandboxError("SANDBOX_START_LINK_MISSING", lines.join("\n"));
  }

  private findMissingLinks(): MissingSandboxdLinks | undefined {
    const stateDir = this.stateDirectory();
    if (stateDir === undefined) return undefined;
    const links = this.linksFromLog(stateDir).filter((link) => !this.probe.exists(link));
    if (links.length === 0) return undefined;
    return { links, stateDir, temp: this.probe.env.TEMP ?? this.probe.env.TMP };
  }

  private stateDirectory(): string | undefined {
    if (this.probe.platform !== "win32") return undefined;
    const localAppData = this.probe.env.LOCALAPPDATA;
    if (!localAppData) return undefined;
    return `${localAppData}\\DockerSandboxes\\sandboxes\\state\\sandboxd`;
  }

  private linksFromLog(stateDir: string): string[] {
    const text = this.probe.readText(`${stateDir}\\daemon.log`);
    if (text === undefined) return [];
    const tail = text.split(/\r?\n/).slice(-LOG_TAIL_LINES).join("\n");
    return rootfsLinkPaths(tail);
  }

  private linkPaths(stateDir: string, temp: string | undefined): string[] {
    const logLinks = this.linksFromLog(stateDir);
    const directories = this.tempDirectories(temp);
    const names = this.linkNames(stateDir, temp, logLinks);
    const candidates = directories.flatMap((directory) =>
      [...names].map((name) => `${directory}\\${name}`),
    );
    return this.uniquePaths([...candidates, ...logLinks]);
  }

  private tempDirectories(temp: string | undefined): string[] {
    const base = `${this.probe.env.LOCALAPPDATA}\\Temp`;
    return [
      base,
      ...this.probe
        .readDir(base)
        .filter((name) => NUMERIC_FOLDER.test(name))
        .map((name) => `${base}\\${name}`),
      ...(temp === undefined ? [] : [stripTrailingSeparators(temp)]),
    ];
  }

  private linkNames(stateDir: string, temp: string | undefined, logLinks: string[]): Set<string> {
    const names = new Set(logLinks.map(lastSegment));
    if (temp !== undefined) {
      for (const name of this.probe.readDir(temp)) {
        const candidate = `${stripTrailingSeparators(temp)}\\${name}`;
        if (
          name.startsWith(LINK_NAME_PREFIX) &&
          pointsTo(this.probe.readLink(candidate), stateDir)
        ) {
          names.add(name);
        }
      }
    }
    return names;
  }

  private uniquePaths(candidates: string[]): string[] {
    const realPath = this.probe.realPath ?? ((directory: string) => directory);
    const paths = new Map<string, string>();
    for (const path of candidates) {
      const key = normalizePath(`${realPath(parentOf(path))}\\${lastSegment(path)}`);
      if (!paths.has(key)) paths.set(key, path);
    }
    return [...paths.values()];
  }

  private inspectLink(path: string, stateDir: string): SandboxDoctorLink {
    const actual = this.probe.readLink(path);
    if (actual === undefined) {
      return this.probe.exists(path)
        ? { path, status: "wrong-target", actual: "not a link" }
        : { path, status: "missing" };
    }

    return pointsTo(actual, stateDir)
      ? { path, status: "ok" }
      : { path, status: "wrong-target", actual };
  }

  private repairLink(link: SandboxDoctorLink, stateDir: string): SandboxDoctorLink {
    if (link.status !== "missing") return link;
    try {
      this.probe.createJunction(link.path, stateDir);
      return { path: link.path, status: "created" };
    } catch (error) {
      return {
        path: link.path,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function sandboxdLinkRepairCommand(link: string, stateDir: string): string {
  return `New-Item -ItemType Junction -Path "${link}" -Target "${stateDir}"`;
}

function rootfsLinkPaths(logText: string): string[] {
  const links = new Set<string>();
  for (const match of logText.matchAll(MISSING_ROOTFS)) links.add(match[1]!);
  return [...links];
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
