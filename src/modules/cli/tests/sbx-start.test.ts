import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test("start launches a stopped sandbox detached and reports it", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");

  const result = await runCliWith(options, "sbx", "start", "--name", "example", "--json");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    dryRun: false,
    sandbox: { provider: "docker-sbx", name: "example" },
    started: true,
  });
  expect(await sandboxCommands(directory.path)).toEqual([
    ["ls", "--json"],
    ["run", "--detach", "--name", "example"],
  ]);
});

test("start is idempotent for a running sandbox", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "running");

  const result = await runCliWith(options, "sbx", "start", "--name", "example");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Sandbox example is already running using docker-sbx.");
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("start infers the sandbox from the current checkout", async () => {
  await using directory = await createTemporaryDirectory();
  const checkout = join(directory.path, "My Project");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const options = await prepareSandboxCli(directory.path, "stopped", "my-project");

  const result = await runCliWith({ ...options, cwd: checkout }, "sbx", "start");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Using sandbox my-project because its name matches");
  expect(result.stdout).toContain("Sandbox my-project is running using docker-sbx.");
  expect((await sandboxCommands(directory.path)).at(-1)).toEqual([
    "run",
    "--detach",
    "--name",
    "my-project",
  ]);
});

test("start dry-run reports the operation without starting", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");

  const result = await runCliWith(options, "sbx", "start", "--name", "example", "--dry-run");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("[dry-run] Start sandbox example using docker-sbx\n");
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("start rejects a nonexistent sandbox", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");

  const result = await runCliWith(options, "sbx", "start", "--name", "example", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_NOT_FOUND");
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("start preserves provider diagnostics in a structured failure", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");
  options.env.EDEN_SBX_START_FAILURE = "start provider failure";

  const result = await runCliWith(options, "sbx", "start", "--name", "example", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_START_FAILED");
  expect(JSON.parse(result.stdout).error.message).toContain("start provider failure");
});
