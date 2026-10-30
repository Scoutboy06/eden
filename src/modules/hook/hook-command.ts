import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export type HookCommand = { executable: string; args: string[] };

export type HookPlatform = {
  platform: NodeJS.Platform;
  which: (name: string) => string | null;
  readHead: (path: string) => Promise<string>;
  listDirectory: (directory: string) => Promise<string[]>;
  bun: string;
  comspec: string;
};

export class HookResolutionError extends Error {
  constructor(
    readonly code: "HOOK_AMBIGUOUS" | "HOOK_UNRUNNABLE",
    message: string,
  ) {
    super(message);
  }
}

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat", ".ps1", ".ts", ".js"];

const systemHookPlatform: HookPlatform = {
  get platform() {
    return process.platform;
  },
  which: (name) => Bun.which(name),
  readHead: async (path) => (await Bun.file(path).slice(0, 512).text()).split(/\r?\n/, 1)[0] ?? "",
  listDirectory: async (directory) => {
    try {
      return await readdir(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];

      throw error;
    }
  },
  bun: process.execPath,
  comspec: process.env.ComSpec || "cmd.exe",
};

export async function findHookFile(
  directory: string,
  name: string,
  system: HookPlatform = systemHookPlatform,
): Promise<string | undefined> {
  if (system.platform !== "win32") return join(directory, name);

  const matches = (await system.listDirectory(directory)).filter(
    (entry) =>
      entry === name ||
      (entry.startsWith(`${name}.`) && WINDOWS_EXTENSIONS.includes(extname(entry).toLowerCase())),
  );

  if (matches.length > 1) {
    const files = matches.map((entry) => join(directory, entry)).join(" and ");

    throw new HookResolutionError(
      "HOOK_AMBIGUOUS",
      `Hook ${name} is ambiguous: found ${files}; keep only one`,
    );
  }

  return matches[0] ? join(directory, matches[0]) : undefined;
}

export async function resolveHookCommand(
  path: string,
  system: HookPlatform = systemHookPlatform,
): Promise<HookCommand> {
  if (system.platform !== "win32") return { executable: path, args: [] };

  switch (extname(path).toLowerCase()) {
    case ".exe":
      return { executable: path, args: [] };
    case ".cmd":
    case ".bat":
      return { executable: system.comspec, args: ["/d", "/s", "/c", "call", path] };
    case ".ps1":
      return powershellCommand(path, system);
    case ".ts":
    case ".js":
      return { executable: system.bun, args: [path] };
    default:
      return shebangCommand(path, system);
  }
}

function powershellCommand(path: string, system: HookPlatform): HookCommand {
  const shell = system.which("pwsh") ?? system.which("powershell");

  if (!shell) {
    throw new HookResolutionError(
      "HOOK_UNRUNNABLE",
      `Hook ${path} needs PowerShell, but neither pwsh nor powershell was found on PATH`,
    );
  }

  return { executable: shell, args: ["-NoProfile", "-File", path] };
}

async function shebangCommand(path: string, system: HookPlatform): Promise<HookCommand> {
  const line = await system.readHead(path);
  const words = line.startsWith("#!") ? line.slice(2).trim().split(/\s+/).filter(Boolean) : [];

  if (words.length === 0) {
    throw new HookResolutionError(
      "HOOK_UNRUNNABLE",
      `Hook ${path} cannot run on Windows: it has no recognized extension and no #! line. Add a shebang such as #!/usr/bin/env bun, or use a .exe, .cmd, .ps1, .ts or .js extension`,
    );
  }

  const [program = "", ...rest] = words;
  const viaEnv = basename(program) === "env";
  const [interpreter = "", ...interpreterArgs] = viaEnv
    ? rest.filter((word) => word !== "-S")
    : [program, ...rest];
  const executable = locateInterpreter(interpreter, system);

  if (!executable) {
    throw new HookResolutionError(
      "HOOK_UNRUNNABLE",
      `Hook ${path} needs interpreter "${basename(interpreter)}" (from "${line.trim()}"), which was not found on PATH`,
    );
  }

  return { executable, args: [...interpreterArgs, path] };
}

function locateInterpreter(interpreter: string, system: HookPlatform): string | null {
  const name = basename(interpreter).replace(/\.exe$/i, "");

  if (name === "bun") return system.bun;

  const found = system.which(name);

  if (found && name === "bash" && /[\\/]windows[\\/]system32[\\/]/i.test(found)) {
    return system.which("sh");
  }

  return found;
}
