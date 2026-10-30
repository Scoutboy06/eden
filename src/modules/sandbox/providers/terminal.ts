import { SandboxError } from "../errors";

export type TerminalRestore = () => void;
export type TerminalSaver = () => TerminalRestore;
export type ConsoleStream = "stdin" | "stdout";
export type ConsoleApi = {
  getMode: (stream: ConsoleStream) => number | undefined;
  setMode: (stream: ConsoleStream, mode: number) => void;
};

const consoleStreams: readonly ConsoleStream[] = ["stdin", "stdout"];

export function saveTerminal(platform: NodeJS.Platform = process.platform): TerminalRestore {
  return platform === "win32" ? saveWindowsTerminal(loadConsoleApi()) : savePosixTerminal();
}

function savePosixTerminal(): TerminalRestore {
  const saved = Bun.spawnSync(["stty", "-g"], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (saved.exitCode !== 0) {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      "Could not save terminal settings before attaching.",
    );
  }

  const settings = saved.stdout.toString().trim();

  return () => {
    Bun.spawnSync(["stty", settings], { stdin: "inherit", stdout: "ignore", stderr: "inherit" });
  };
}

export function saveWindowsTerminal(
  api: ConsoleApi | undefined,
  stdin: { setRawMode?: (mode: boolean) => unknown } = process.stdin,
): TerminalRestore {
  const saved = new Map<ConsoleStream, number>();

  for (const stream of consoleStreams) {
    const mode = readMode(api, stream);
    if (mode !== undefined) saved.set(stream, mode);
  }

  return () => {
    if (!saved.has("stdin")) tryIgnoring(() => stdin.setRawMode?.(false));

    for (const [stream, mode] of saved) {
      tryIgnoring(() => api?.setMode(stream, mode));
    }
  };
}

function loadConsoleApi(): ConsoleApi | undefined {
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const { symbols } = dlopen("kernel32.dll", {
      GetStdHandle: { args: [FFIType.i32], returns: FFIType.u64 },
      GetConsoleMode: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
      SetConsoleMode: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    });
    const handleOf = (stream: ConsoleStream) =>
      symbols.GetStdHandle(stream === "stdin" ? -10 : -11);

    return {
      getMode: (stream) => {
        const mode = new Uint32Array(1);

        return symbols.GetConsoleMode(handleOf(stream), mode) !== 0 ? mode[0] : undefined;
      },
      setMode: (stream, mode) => {
        symbols.SetConsoleMode(handleOf(stream), mode);
      },
    };
  } catch {
    return undefined;
  }
}

function readMode(api: ConsoleApi | undefined, stream: ConsoleStream): number | undefined {
  try {
    return api?.getMode(stream);
  } catch {
    return undefined;
  }
}

function tryIgnoring(action: () => unknown): void {
  try {
    action();
  } catch {}
}
