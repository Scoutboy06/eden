import { beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../support/cli";

const interaction = fileURLToPath(new URL("../fixtures/complete.ps1", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/completion.ts", import.meta.url));
let script: string;

beforeAll(async () => {
  script = await Bun.$`${process.execPath} ${fixture} completion pwsh --stdout`.text();
});

const pwshTest = test.skipIf(Bun.which("pwsh") === null);

async function complete(line: string, source = script): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "eden-pwsh-completion-"));
  try {
    const path = join(directory, "eden.ps1");
    const work = join(directory, "work");
    await mkdir(work);
    await writeFile(path, source);
    const output = await Bun.$`pwsh -NoProfile -NonInteractive -File ${interaction} ${path} ${line}`
      .cwd(work)
      .text();
    return JSON.parse(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

pwshTest("PowerShell completes application commands and global options", async () => {
  const result = await runCli("completion", "pwsh", "--stdout", "--json");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(await complete("eden mk", result.stdout)).toEqual(["mkdir"]);
  expect(await complete("eden --dry-r", result.stdout)).toEqual(["--dry-run"]);
  expect(await complete("eden mkdir --dry-r", result.stdout)).toEqual(["--dry-run"]);
  expect(await complete("eden mkdir -", result.stdout)).toContain("-h");
  expect(await complete("eden mkdir -", result.stdout)).toContain("-v");
});

pwshTest("PowerShell completes nested commands after global flags", async () => {
  expect(await complete("eden --json workspace cr")).toEqual(["create"]);
  expect(await complete("eden workspace --dry-run create --workspace-ro")).toEqual([
    "--workspace-root",
  ]);
  expect(await complete("eden workspace create -")).toContain("-o");
});

pwshTest("PowerShell completes separate and attached option choices", async () => {
  expect(await complete("eden workspace create --output j")).toEqual(["json"]);
  expect(await complete("eden workspace create -o j")).toEqual(["json"]);
  expect(await complete("eden workspace create --output=j")).toEqual(["--output=json"]);
  expect(await complete("eden workspace create -oj")).toEqual(["-ojson"]);
  expect(await complete("eden workspace create --output ")).toEqual(["table", "json"]);
});

pwshTest("PowerShell consumes option values before finding the next positional", async () => {
  expect(await complete("eden workspace create --workspace-root choose --output j")).toEqual([
    "json",
  ]);
  expect(await complete("eden choose --format json a")).toEqual(["alpha"]);
  expect(await complete("eden choose --format=json alpha t")).toEqual(["two"]);
});

pwshTest(
  "PowerShell completes declared positional choices and respects the delimiter",
  async () => {
    expect(await complete("eden completion ")).toEqual(["zsh", "bash", "pwsh"]);
    expect(await complete("eden completion p")).toEqual(["pwsh"]);
    expect(await complete("eden choose -- --d")).toEqual(["--dash"]);
    expect(await complete("eden choose -- alpha t")).toEqual(["two"]);
    expect(await complete("eden workspace create -- --out")).toEqual([]);
    expect(await complete("eden choose alpha two ")).toEqual([]);
  },
);

pwshTest("PowerShell quotes shell-sensitive values literally", async () => {
  expect(await complete("eden workspace create --label l")).toEqual([
    "'literal: [x] don''t $(print INJECTED)'",
  ]);
  expect(await complete("eden choose s")).toEqual([
    "'spaces and ''quotes'' $(printf INJECTED) `printf INJECTED`'",
  ]);
  expect(await complete("eden choose m")).toEqual(["'multi\nline'"]);
  expect(await complete("eden choose *")).toEqual(["'*literal'"]);
});

pwshTest("PowerShell hides internal commands and hidden options", async () => {
  expect(await complete("eden ")).not.toContain("internal");
  expect(await complete("eden ")).not.toContain("eden");
  expect(await complete("eden choose --sec")).toEqual([]);
  expect(await complete("eden choose --secret alpha a")).toEqual(["alpha"]);
});

test("PowerShell generator doubles quote characters in emitted literals", () => {
  expect(script).toContain("'literal: [x] don''t $(print INJECTED)'");
  expect(script).toContain("-CommandName 'eden'");
});
