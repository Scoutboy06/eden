import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
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
        error: { code: "SANDBOX_NOT_FOUND", message: expect.stringContaining("eden sbx create") },
      });
    } else {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Sandbox typo was not found");
      expect(result.stderr).toContain("eden sbx create");
    }
    expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
  });
});

test.each(["--profile", "--image"])(
  "run rejects creation-only option %s before provider calls",
  async (flag) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");

      const result = await runCliWith(options, "sbx", "run", "--name", "example", flag, "work");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(flag.slice(2));
      expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
    });
  },
);

test("run rejects an empty name before provider calls", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");

    const result = await runCliWith(options, "sbx", "run", "--name", " ");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must not be empty");
    expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
  });
});
