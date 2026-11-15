import { expect, test } from "bun:test";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test("ssh prints a JSON connection description without changing the sandbox", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "running");

  const result = await runCliWith(options, "sbx", "ssh", "--name", "example", "--json");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    dryRun: false,
    sandbox: { provider: "docker-sbx", name: "example", status: "running" },
    ssh: {
      host: "example.sbx",
      command: ["ssh", "example.sbx"],
      setupCommand: ["sbx", "setup", "ssh"],
    },
  });
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test("ssh presents the command, editor host and setup hint, and notes a stopped sandbox", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "stopped");

  const result = await runCliWith(options, "sbx", "ssh", "--name", "example");

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("  ssh example.sbx\n");
  expect(result.stdout).toContain("VS Code Remote-SSH");
  expect(result.stdout).toContain("  sbx setup ssh\n");
  expect(result.stdout).toContain("eden sbx run --provider docker-sbx --name example");
});

test("ssh rejects a nonexistent sandbox", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");

  const result = await runCliWith(options, "sbx", "ssh", "--name", "example", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "SANDBOX_NOT_FOUND" },
  });
});
