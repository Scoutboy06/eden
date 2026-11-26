import { beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { completionCommands } from "../fixtures/completion-commands";
import { runCli } from "../support/cli";
import { parseCommands } from "../support/parser";

const interaction = fileURLToPath(new URL("../fixtures/complete.ps1", import.meta.url));
let script: string;

beforeAll(async () => {
  script = (await parseCommands(completionCommands, "completion", "pwsh")).stdout;
});

const pwshTest = test.skipIf(Bun.which("pwsh") === null);

async function completeMany(lines: string[], source = script): Promise<string[][]> {
  const directory = await mkdtemp(join(tmpdir(), "eden-pwsh-completion-"));
  try {
    const path = join(directory, "eden.ps1");
    const work = join(directory, "work");
    await mkdir(work);
    await writeFile(path, source);
    const output =
      await Bun.$`pwsh -NoProfile -NonInteractive -File ${interaction} ${path} ${JSON.stringify(lines)}`
        .cwd(work)
        .text();
    return JSON.parse(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

pwshTest("PowerShell completes application commands and global options", async () => {
  const result = await runCli("completion", "pwsh", "--json");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const [command, globalOption, commandOption, shortHelp, shortVersion] = await completeMany(
    ["eden mk", "eden --dry-r", "eden mkdir --dry-r", "eden mkdir -", "eden mkdir -"],
    result.stdout,
  );
  expect(command).toEqual(["mkdir"]);
  expect(globalOption).toEqual(["--dry-run"]);
  expect(commandOption).toEqual(["--dry-run"]);
  expect(shortHelp).toContain("-h");
  expect(shortVersion).toContain("-v");
});

pwshTest("PowerShell completes nested commands after global flags", async () => {
  const [nestedCommand, workspaceOption, outputOption] = await completeMany([
    "eden --json workspace cr",
    "eden workspace --dry-run create --workspace-ro",
    "eden workspace create -",
  ]);
  expect(nestedCommand).toEqual(["create"]);
  expect(workspaceOption).toEqual(["--workspace-root"]);
  expect(outputOption).toContain("-o");
});

pwshTest("PowerShell completes separate and attached option choices", async () => {
  const [long, short, attachedLong, attachedShort, empty] = await completeMany([
    "eden workspace create --output j",
    "eden workspace create -o j",
    "eden workspace create --output=j",
    "eden workspace create -oj",
    "eden workspace create --output ",
  ]);
  expect(long).toEqual(["json"]);
  expect(short).toEqual(["json"]);
  expect(attachedLong).toEqual(["--output=json"]);
  expect(attachedShort).toEqual(["-ojson"]);
  expect(empty).toEqual(["table", "json"]);
});

pwshTest("PowerShell consumes option values before finding the next positional", async () => {
  const [workspace, separateFormat, attachedFormat] = await completeMany([
    "eden workspace create --workspace-root choose --output j",
    "eden choose --format json a",
    "eden choose --format=json alpha t",
  ]);
  expect(workspace).toEqual(["json"]);
  expect(separateFormat).toEqual(["alpha"]);
  expect(attachedFormat).toEqual(["two"]);
});

pwshTest(
  "PowerShell completes declared positional choices and respects the delimiter",
  async () => {
    const [shells, shell, dash, afterDelimiter, output, exhausted] = await completeMany([
      "eden completion ",
      "eden completion p",
      "eden choose -- --d",
      "eden choose -- alpha t",
      "eden workspace create -- --out",
      "eden choose alpha two ",
    ]);
    expect(shells).toEqual(["zsh", "bash", "pwsh"]);
    expect(shell).toEqual(["pwsh"]);
    expect(dash).toEqual(["--dash"]);
    expect(afterDelimiter).toEqual(["two"]);
    expect(output).toEqual([]);
    expect(exhausted).toEqual([]);
  },
);

pwshTest("PowerShell quotes shell-sensitive values literally", async () => {
  const [label, spaces, multiline, wildcard] = await completeMany([
    "eden workspace create --label l",
    "eden choose s",
    "eden choose m",
    "eden choose *",
  ]);
  expect(label).toEqual(["'literal: [x] don''t $(print INJECTED)'"]);
  expect(spaces).toEqual(["'spaces and ''quotes'' $(printf INJECTED) `printf INJECTED`'"]);
  expect(multiline).toEqual(["'multi\nline'"]);
  expect(wildcard).toEqual(["'*literal'"]);
});

pwshTest("PowerShell hides internal commands and hidden options", async () => {
  const [commands, commandsAgain, hiddenOption, secretValue] = await completeMany([
    "eden ",
    "eden ",
    "eden choose --sec",
    "eden choose --secret alpha a",
  ]);
  expect(commands).not.toContain("internal");
  expect(commandsAgain).not.toContain("eden");
  expect(hiddenOption).toEqual([]);
  expect(secretValue).toEqual(["alpha"]);
});

test("PowerShell generator doubles quote characters in emitted literals", () => {
  expect(script).toContain("'literal: [x] don''t $(print INJECTED)'");
  expect(script).toContain("-CommandName 'eden'");
});
