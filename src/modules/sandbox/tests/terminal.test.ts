import { expect, test } from "bun:test";
import { saveWindowsTerminal, type ConsoleApi, type ConsoleStream } from "../providers/terminal";

function fakeConsole(initial: Partial<Record<ConsoleStream, number>>) {
  const modes = { ...initial };
  const writes: Array<[ConsoleStream, number]> = [];
  const api: ConsoleApi = {
    getMode: (stream) => modes[stream],
    setMode: (stream, mode) => {
      writes.push([stream, mode]);
      modes[stream] = mode;
    },
  };

  return { api, modes, writes };
}

test("windows terminal restores saved stdin and stdout modes", () => {
  const console = fakeConsole({ stdin: 0x1f7, stdout: 0x7 });
  const restore = saveWindowsTerminal(console.api, {});

  console.modes.stdin = 0x1f0;
  console.modes.stdout = 0x3;
  restore();

  expect(console.modes).toEqual({ stdin: 0x1f7, stdout: 0x7 });
});

test("windows terminal restore does not touch the console before it runs", () => {
  const console = fakeConsole({ stdin: 1, stdout: 2 });

  saveWindowsTerminal(console.api, {});

  expect(console.writes).toEqual([]);
});

test("windows terminal restores only the streams that were consoles", () => {
  const console = fakeConsole({ stdout: 7 });
  const rawModes: boolean[] = [];
  const restore = saveWindowsTerminal(console.api, { setRawMode: (mode) => rawModes.push(mode) });

  restore();

  expect(console.writes).toEqual([["stdout", 7]]);
  expect(rawModes).toEqual([false]);
});

test("windows terminal falls back to leaving raw mode when no console mode is readable", () => {
  const rawModes: boolean[] = [];
  const restore = saveWindowsTerminal(fakeConsole({}).api, {
    setRawMode: (mode) => rawModes.push(mode),
  });

  restore();

  expect(rawModes).toEqual([false]);
});

test("windows terminal falls back when the console api is unavailable", () => {
  const rawModes: boolean[] = [];
  const restore = saveWindowsTerminal(undefined, { setRawMode: (mode) => rawModes.push(mode) });

  restore();

  expect(rawModes).toEqual([false]);
});

test("windows terminal survives a throwing console api and a stdin without raw mode", () => {
  const api: ConsoleApi = {
    getMode: () => {
      throw new Error("ffi failed");
    },
    setMode: () => {
      throw new Error("ffi failed");
    },
  };

  expect(() => saveWindowsTerminal(api, {})()).not.toThrow();
});

test("windows terminal restore continues past a failing setMode", () => {
  const console = fakeConsole({ stdin: 1, stdout: 2 });
  const failing: ConsoleApi = {
    getMode: console.api.getMode,
    setMode: (stream, mode) => {
      if (stream === "stdin") throw new Error("boom");
      console.api.setMode(stream, mode);
    },
  };

  saveWindowsTerminal(failing, {})();

  expect(console.writes).toEqual([["stdout", 2]]);
});
