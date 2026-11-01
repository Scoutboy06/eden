import { expect, test } from "bun:test";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test("force removes only the requested sandbox", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");
    const result = await runCliWith(options, "sbx", "rm", "--name", "example", "--force", "--json");
    expect(result.exitCode).toBe(0);
    expect(await sandboxCommands(directory)).toEqual([
      ["ls", "--json"],
      ["rm", "--force", "--", "example"],
    ]);
  });
});

test("running sandbox requires force", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");
    const result = await runCliWith(
      options,
      "sbx",
      "rm",
      "--name",
      "example",
      "--dry-run",
      "--json",
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_REMOVE_REQUIRES_FORCE");
  });
});
