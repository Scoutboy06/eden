import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../support/cli";

const interaction = fileURLToPath(new URL("../fixtures/complete.bash", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/completion.ts", import.meta.url));
const readline = fileURLToPath(new URL("../fixtures/complete-bash.zsh", import.meta.url));
let script: string;

beforeAll(async () => {
  script = await Bun.$`${process.execPath} ${fixture} completion bash --stdout`.text();
});

async function withScript<T>(source: string, action: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "eden-bash-completion-"));
  try {
    const path = join(directory, "eden.bash");
    await writeFile(path, source);
    return await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function complete(words: string[], source = script): Promise<string[]> {
  return withScript(source, async (path) => {
    const output = await Bun.$`bash --noprofile --norc ${interaction} ${path} eden ${words}`.text();
    return output ? output.slice(0, -1).split("\0") : [];
  });
}

test("Bash Readline inserts choices safely with its default word breaks", async () => {
  for (const [input, expected] of [
    ["eden workspace create --output=j", "workspace create --output=json"],
    [
      "eden workspace create --label=",
      "workspace create --label=literal: [x] don't $(print INJECTED)",
    ],
    ["eden --json workspace cr", "--json workspace create"],
    ["eden choose s", "choose spaces and 'quotes' $(printf INJECTED) `printf INJECTED`"],
    ["eden odd:co", "odd:command"],
    ["eden odd:", "odd:command"],
  ]) {
    const output = await withScript(script, (path) =>
      Bun.$`timeout 10 zsh ${readline} ${path} ${input}`.text(),
    );

    expect(output).toContain(`RESULT:${expected}\r\n`);
    expect(output).not.toContain("RESULT:choose spaces and 'quotes' INJECTED");
  }
});

test("Bash completes application commands and global options", async () => {
  const result = await runCli("completion", "bash", "--stdout", "--json");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(await complete(["mk"], result.stdout)).toEqual(["mkdir"]);
  expect(await complete(["--dry-r"], result.stdout)).toEqual(["--dry-run"]);
  expect(await complete(["mkdir", "--dry-r"], result.stdout)).toEqual(["--dry-run"]);
  expect(await complete(["mkdir", "-"], result.stdout)).toContain("-h");
  expect(await complete(["mkdir", "-"], result.stdout)).toContain("-v");
});

test("Bash completes nested commands after global flags without invoking handlers", async () => {
  expect(await complete(["--json", "workspace", "cr"])).toEqual(["create"]);
  expect(await complete(["workspace", "--dry-run", "create", "--workspace-ro"])).toEqual([
    "--workspace-root",
  ]);
  expect(await complete(["workspace", "create", "-"])).toContain("-o");
});

test("Bash completes separate, attached, and word-broken option choices", async () => {
  for (const words of [
    ["--output", "j"],
    ["-o", "j"],
    ["--output", "=", "j"],
    ["--output=", "j"],
  ]) {
    expect(await complete(["workspace", "create", ...words])).toEqual(["json"]);
  }
  expect(await complete(["workspace", "create", "--output=j"])).toEqual(["--output=json"]);
  expect(await complete(["workspace", "create", "-oj"])).toEqual(["-ojson"]);
  expect(await complete(["workspace", "create", "--output", "=", ""])).toEqual(["table", "json"]);
});

test("Bash consumes option values before finding the next positional", async () => {
  expect(
    await complete(["workspace", "create", "--workspace-root", "choose", "--output", "j"]),
  ).toEqual(["json"]);
  expect(await complete(["choose", "--format", "json", "a"])).toEqual(["alpha"]);
  expect(await complete(["choose", "--format=json", "alpha", "t"])).toEqual(["two"]);
  expect(await complete(["choose", "--format", "--", "a"])).toEqual(["alpha"]);
});

test("Bash completes declared positional choices and respects the option delimiter", async () => {
  expect(await complete(["completion", "b"])).toEqual(["bash"]);
  expect(await complete(["choose", "--", "--d"])).toEqual(["--dash"]);
  expect(await complete(["choose", "--", "alpha", "t"])).toEqual(["two"]);
  expect(await complete(["workspace", "create", "--", "--out"])).toEqual([]);
  expect(await complete(["choose", "alpha", "two", ""])).toEqual([]);
});

test("Bash keeps shell-sensitive values literal and preserves whitespace", async () => {
  expect(await complete(["workspace", "create", "--label", "l"])).toEqual([
    String.raw`literal:\ \[x\]\ don\'t\ \$\(print\ INJECTED\)`,
  ]);
  expect(await complete(["choose", "--format", "$(touch /tmp/EDEN_INJECTED)"])).toEqual([]);
  expect(await complete(["choose", "m"])).toEqual([String.raw`$'multi\nline'`]);
  expect(await complete(["choose", "*"])).toEqual([String.raw`\*literal`]);
  expect(await complete(["choose", "s"])).toEqual([
    String.raw`spaces\ and\ \'quotes\'\ \$\(printf\ INJECTED\)\ \`printf\ INJECTED\``,
  ]);
});

test("Bash handles colon word breaks without evaluating command names", async () => {
  expect(await complete(["odd"])).toEqual(["odd:command"]);
  expect(await complete(["odd", ":", "co"])).toEqual(["command"]);
});

test("Bash hides internal commands and hidden options while consuming hidden values", async () => {
  expect(await complete([""])).not.toContain("internal");
  expect(await complete(["choose", "--sec"])).toEqual([]);
  expect(await complete(["choose", "--secret", "alpha", "a"])).toEqual(["alpha"]);
});
