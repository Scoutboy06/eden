import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  findHookFile,
  HookResolutionError,
  resolveHookCommand,
  type HookPlatform,
} from "../hook-command";

function platform(overrides: Partial<HookPlatform> & { head?: string; files?: string[] } = {}) {
  const { head = "", files = [], ...rest } = overrides;
  const tools: Record<string, string> = {
    pwsh: "C:/pwsh.exe",
    powershell: "C:/powershell.exe",
    sh: "C:/git/sh.exe",
    bash: "C:/git/bash.exe",
    node: "C:/node.exe",
  };

  return {
    platform: "win32",
    which: (name: string) => tools[name] ?? null,
    readHead: async () => head,
    listDirectory: async () => files,
    bun: "C:/bun.exe",
    comspec: "C:/cmd.exe",
    ...rest,
  } satisfies HookPlatform;
}

describe("resolveHookCommand", () => {
  test("runs the path directly on non-Windows platforms", async () => {
    const command = await resolveHookCommand("/h/pre.cmd", platform({ platform: "linux" }));

    expect(command).toEqual({ executable: "/h/pre.cmd", args: [] });
  });

  test.each([
    ["C:/h/pre.exe", { executable: "C:/h/pre.exe", args: [] }],
    [
      "C:/h/pre.cmd",
      { executable: "C:/cmd.exe", args: ["/d", "/s", "/c", "call", "C:/h/pre.cmd"] },
    ],
    [
      "C:/h/pre.BAT",
      { executable: "C:/cmd.exe", args: ["/d", "/s", "/c", "call", "C:/h/pre.BAT"] },
    ],
    ["C:/h/pre.ps1", { executable: "C:/pwsh.exe", args: ["-NoProfile", "-File", "C:/h/pre.ps1"] }],
    ["C:/h/pre.ts", { executable: "C:/bun.exe", args: ["C:/h/pre.ts"] }],
    ["C:/h/pre.js", { executable: "C:/bun.exe", args: ["C:/h/pre.js"] }],
  ])("maps %s by extension", async (path, expected) => {
    expect(await resolveHookCommand(path, platform())).toEqual(expected);
  });

  test("falls back to powershell when pwsh is absent", async () => {
    const system = platform({ which: (name) => (name === "powershell" ? "C:/ps.exe" : null) });

    expect(await resolveHookCommand("C:/h/pre.ps1", system)).toEqual({
      executable: "C:/ps.exe",
      args: ["-NoProfile", "-File", "C:/h/pre.ps1"],
    });
  });

  test("fails clearly when no PowerShell exists", async () => {
    const system = platform({ which: () => null });

    expect(resolveHookCommand("C:/h/pre.ps1", system)).rejects.toMatchObject({
      code: "HOOK_UNRUNNABLE",
      message: expect.stringContaining("PowerShell"),
    });
  });

  test.each([
    ["#!/usr/bin/env bun", { executable: "C:/bun.exe", args: ["C:/h/pre"] }],
    ["#!/usr/bin/env bun\r", { executable: "C:/bun.exe", args: ["C:/h/pre"] }],
    ["#!/usr/bin/env node", { executable: "C:/node.exe", args: ["C:/h/pre"] }],
    [
      "#!/usr/bin/env -S node --no-warnings",
      { executable: "C:/node.exe", args: ["--no-warnings", "C:/h/pre"] },
    ],
    ["#!/bin/sh", { executable: "C:/git/sh.exe", args: ["C:/h/pre"] }],
    ["#!/bin/bash -e", { executable: "C:/git/bash.exe", args: ["-e", "C:/h/pre"] }],
  ])("runs the interpreter of extensionless %j", async (head, expected) => {
    expect(await resolveHookCommand("C:/h/pre", platform({ head }))).toEqual(expected);
  });

  test("rejects an extensionless file without a shebang", async () => {
    const result = resolveHookCommand("C:/h/pre", platform({ head: "echo hi" }));

    expect(result).rejects.toBeInstanceOf(HookResolutionError);
    expect(result).rejects.toMatchObject({
      code: "HOOK_UNRUNNABLE",
      message: expect.stringContaining("no #! line"),
    });
  });

  test("rejects a shebang whose interpreter is missing", async () => {
    const system = platform({ head: "#!/bin/bash", which: () => null });

    expect(resolveHookCommand("C:/h/pre", system)).rejects.toMatchObject({
      code: "HOOK_UNRUNNABLE",
      message: expect.stringContaining('"bash"'),
    });
  });

  test("does not use the WSL bash launcher", async () => {
    const system = platform({
      head: "#!/bin/bash",
      which: (name) => (name === "bash" ? "C:/Windows/System32/bash.exe" : "C:/git/sh.exe"),
    });

    expect((await resolveHookCommand("C:/h/pre", system)).executable).toBe("C:/git/sh.exe");
  });
});

describe("findHookFile", () => {
  test("uses the exact name on non-Windows platforms without listing", async () => {
    const system = platform({
      platform: "linux",
      listDirectory: async () => {
        throw new Error("unexpected");
      },
    });

    expect(await findHookFile("/h", "worktree.create.pre", system)).toBe(
      join("/h", "worktree.create.pre"),
    );
  });

  test.each(["worktree.create.pre", "worktree.create.pre.ps1", "worktree.create.pre.CMD"])(
    "finds %s on Windows",
    async (file) => {
      const system = platform({ files: [file, "worktree.create.post.cmd", "other"] });
      const found = await findHookFile("C:/h", "worktree.create.pre", system);

      expect(found).toEndWith(file);
    },
  );

  test("ignores unknown extensions and prefix-sharing names", async () => {
    const system = platform({
      files: ["worktree.create.pre.bak", "worktree.create.pre.ps1.bak", "worktree.create.prefix"],
    });

    expect(await findHookFile("C:/h", "worktree.create.pre", system)).toBeUndefined();
  });

  test("returns nothing when no hook exists", async () => {
    expect(await findHookFile("C:/h", "worktree.create.pre", platform())).toBeUndefined();
  });

  test("names both files when the hook is ambiguous", async () => {
    const system = platform({ files: ["worktree.create.pre", "worktree.create.pre.cmd"] });
    const result = findHookFile("C:/h", "worktree.create.pre", system);

    expect(result).rejects.toMatchObject({
      code: "HOOK_AMBIGUOUS",
      message: expect.stringMatching(/worktree\.create\.pre and .*worktree\.create\.pre\.cmd/),
    });
  });

  test("rejects two extensions of the same hook", async () => {
    const system = platform({ files: ["worktree.create.pre.ps1", "worktree.create.pre.cmd"] });

    expect(findHookFile("C:/h", "worktree.create.pre", system)).rejects.toMatchObject({
      code: "HOOK_AMBIGUOUS",
    });
  });
});
