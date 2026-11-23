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

const LOG_TAIL_BYTES = 256 * 1024;

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
