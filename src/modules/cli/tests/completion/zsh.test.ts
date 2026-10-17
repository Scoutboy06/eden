import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../support/cli";

const interaction = fileURLToPath(new URL("../fixtures/complete.zsh", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/completion.ts", import.meta.url));

async function complete(script: string, input: string) {
  const directory = await mkdtemp(join(tmpdir(), "eden-completion-"));
  try {
    const path = join(directory, "_eden");
    await writeFile(path, script);
    return await Bun.$`timeout 10 zsh ${interaction} ${path} ${input}`.text();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the generated Zsh script completes an application command", async () => {
  const result = await runCli("completion", "zsh", "--stdout");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(await complete(result.stdout, "eden mk")).toContain("RESULT:mkdir\r\n");
});

test("Zsh completes a global option after a command", async () => {
  const result = await runCli("completion", "zsh", "--stdout");

  expect(await complete(result.stdout, "eden mkdir --dry-r")).toContain(
    "RESULT:mkdir --dry-run\r\n",
  );
});

test("Zsh does not complete positional input as an option after --", async () => {
  const result = await runCli("completion", "zsh", "--stdout");

  expect(await complete(result.stdout, "eden mkdir -- --dry-r")).toContain(
    "RESULT:mkdir -- --dry-r\r\n",
  );
});

test("Zsh offers the parser's short option aliases", async () => {
  const result = await runCli("completion", "zsh", "--stdout");
  const output = await complete(result.stdout, "eden mkdir -\t");

  expect(output).toMatch(/\s-h\s/);
  expect(output).toMatch(/\s-v\s/);
});

test("Zsh completes a nested command without invoking its handler", async () => {
  const script = await Bun.$`${process.execPath} ${fixture} completion zsh --stdout`.text();

  expect(await complete(script, "eden workspace cr")).toContain("RESULT:workspace create\r\n");
});

test("Zsh completes a nested command's declared option values", async () => {
  const script = await Bun.$`${process.execPath} ${fixture} completion zsh --stdout`.text();

  expect(await complete(script, "eden workspace create --output j")).toContain(
    "RESULT:workspace create --output json\r\n",
  );
});

test("Zsh completes inline option values after preceding global flags", async () => {
  const script = await Bun.$`${process.execPath} ${fixture} completion zsh --stdout`.text();

  expect(await complete(script, "eden --json workspace create --output=j")).toContain(
    "RESULT:--json workspace create --output=json\r\n",
  );
});

test("Zsh completes the declared shell positional choice", async () => {
  const result = await runCli("completion", "zsh", "--stdout");

  expect(await complete(result.stdout, "eden completion z")).toContain("RESULT:completion zsh\r\n");
});

test("Zsh treats shell-sensitive descriptions and choices as literal text", async () => {
  const script = await Bun.$`${process.execPath} ${fixture} completion zsh --stdout`.text();
  const output = await complete(script, "eden workspace create --label l");

  expect(output).toContain(
    "RESULT:workspace create --label literal: [x] don't $(print INJECTED)\r\n",
  );
  expect(output).not.toContain("\r\nINJECTED\r\n");
});

test("Zsh completes command names containing a description delimiter", async () => {
  const script = await Bun.$`${process.execPath} ${fixture} completion zsh --stdout`.text();

  expect(await complete(script, "eden odd")).toContain("RESULT:odd:command\r\n");
});

test("Zsh uses the option spelling accepted by a kebab-case command", async () => {
  const script = await Bun.$`${process.execPath} ${fixture} completion zsh --stdout`.text();

  expect(await complete(script, "eden workspace create --workspace-ro")).toContain(
    "RESULT:workspace create --workspace-root\r\n",
  );
});

test("Zsh displays option descriptions without interpreting their punctuation", async () => {
  const script = await Bun.$`${process.execPath} ${fixture} completion zsh --stdout`.text();
  const output = await complete(script, "eden workspace create --\t");

  expect(output).toContain("Choose [label]: don't evaluate $text");
});

test("unsupported shells fail enum validation without emitting a script", async () => {
  const result = await runCli("completion", "bash", "--stdout", "--json");

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).error.code).toBe("err:arg:invalid-choice");
});
