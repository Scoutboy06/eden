import { expect, test } from "bun:test";
import sbx from "../../../../apps/cli/src/commands/sbx";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { parseCommands } from "./support/parser";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.each([false, true])("run never creates a missing sandbox, dryRun=%s", async (dryRun) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    options.env.EDEN_SBX_POLICY_FAILURE = "creation preflight must not run";

    const result = await runCliWith(
      options,
      "sbx",
      "run",
      "--name",
      "typo",
      ...(dryRun ? ["--dry-run", "--json"] : []),
    );

    expect(result.exitCode).toBe(1);
    if (dryRun) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        dryRun: true,
        error: { code: "SANDBOX_NOT_FOUND", message: expect.stringContaining("--provider") },
      });
    } else {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Sandbox typo was not found");
      expect(result.stderr).toContain("--provider");
      expect(result.stderr).toContain("eden sbx create");
    }
    expect(await sandboxCommands(directory)).toEqual([["ls", "--json"]]);
  });
});

test.each(["--profile", "--image"])("run parser rejects creation-only option %s", async (flag) => {
  const result = await parseCommands({ sbx }, "sbx", "run", "--name", "example", flag, "work");

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(flag.slice(2));
});
