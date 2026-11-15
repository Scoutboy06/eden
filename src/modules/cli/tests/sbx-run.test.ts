import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith, withRunningCli } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

const application = fileURLToPath(new URL("../../../../apps/cli/src/main.ts", import.meta.url));

test.each(["running", "stopped", "failure"])(
  "run attaches with provider output and exit status: %s",
  async (mode) => {
    await using directory = await createTemporaryDirectory();
    const options = await prepareSandboxCli(directory.path, mode, "name with ' quotes");

    const result = await runCliWith(options, "sbx", "run", "--name", "name with ' quotes");

    expect(result).toEqual({
      exitCode: mode === "failure" ? 7 : 0,
      stdout: "attached\n",
      stderr: "provider stderr\n",
    });
    expect(await sandboxCommands(directory.path)).toEqual([
      ["ls", "--json"],
      ["run", "--name", "name with ' quotes"],
    ]);
  },
);

test("run refuses malformed listing without creation or attachment", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "malformed");

  const result = await runCliWith(options, "sbx", "run", "--name", "example");

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("invalid sandbox listing JSON");
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("run JSON dry-run checks existence and reports attachment without launching it", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");

  const result = await runCliWith(
    options,
    "sbx",
    "run",
    "--name",
    "example",
    "--dry-run",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    dryRun: true,
    operations: [
      {
        type: "sandbox.run",
        description: "Attach to sandbox example using docker-sbx",
        input: { provider: "docker-sbx", name: "example" },
      },
    ],
  });
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("run rejects JSON before contacting the provider", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "running");

  const result = await runCliWith(options, "sbx", "run", "--name", "example", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "SANDBOX_INVALID_INPUT" },
  });
  expect(await Bun.file(join(directory.path, "commands")).exists()).toBe(false);
});

test("run inherits stdin", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stdin");
  const child = Bun.spawn([process.execPath, application, "sbx", "run", "--name", "example"], {
    ...options,
    env: { ...process.env, ...options.env },
    stdin: Buffer.from("hello\n"),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect({ exitCode, stdout, stderr }).toEqual({
    exitCode: 0,
    stdout: "input:hello\n",
    stderr: "",
  });
});

test.skipIf(process.platform === "win32").each(["interrupt", "ignore"])(
  "run cancels the attached provider: %s",
  async (mode) => {
    await using directory = await createTemporaryDirectory();
    const options = await prepareSandboxCli(directory.path, mode);

    await withRunningCli(options, ["sbx", "run", "--name", "example"], async (cli) => {
      await cli.waitForReady(join(directory.path, "ready"));
      cli.interrupt();
      const result = await cli.result;

      expect(result.exitCode).toBe(130);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  },
);

async function prepareInference(directory: string, mode: string, sandboxName: string) {
  const checkout = join(directory, "My Project");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const options = await prepareSandboxCli(directory, mode, sandboxName);

  return { checkout, options: { ...options, cwd: checkout } };
}

test("run infers the sandbox from the workspace of the current checkout", async () => {
  await using directory = await createTemporaryDirectory();
  const { checkout, options } = await prepareInference(directory.path, "running", "custom-name");
  options.env.EDEN_SBX_LIST_RESULT = JSON.stringify([
    { name: "custom-name", status: "running", workspaces: [checkout] },
    { name: "my-project", status: "running", workspaces: [join(directory.path, "elsewhere")] },
  ]);

  const result = await runCliWith(options, "sbx", "run");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Using sandbox custom-name because its workspace");
  expect(await sandboxCommands(directory.path)).toEqual([
    ["ls", "--json"],
    ["ls", "--json"],
    ["run", "--name", "custom-name"],
  ]);
});

test("run infers the sandbox from the derived checkout name", async () => {
  await using directory = await createTemporaryDirectory();
  const { options } = await prepareInference(directory.path, "running", "my-project");

  const result = await runCliWith(options, "sbx", "run");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Using sandbox my-project because its name matches");
  expect((await sandboxCommands(directory.path)).at(-1)).toEqual(["run", "--name", "my-project"]);
});

test("run without a matching sandbox fails without attaching", async () => {
  await using directory = await createTemporaryDirectory();
  const { options } = await prepareInference(directory.path, "missing", "my-project");

  const result = await runCliWith(options, "sbx", "run", "--dry-run", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_NOT_FOUND");
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("run with several matching sandboxes fails without attaching", async () => {
  await using directory = await createTemporaryDirectory();
  const { checkout, options } = await prepareInference(directory.path, "running", "a");
  options.env.EDEN_SBX_LIST_RESULT = JSON.stringify([
    { name: "a", status: "running", workspaces: [checkout] },
    { name: "b", status: "running", workspaces: [checkout] },
  ]);

  const result = await runCliWith(options, "sbx", "run", "--dry-run", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.message).toContain("a, b");
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});
