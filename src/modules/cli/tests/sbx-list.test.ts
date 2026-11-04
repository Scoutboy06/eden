import { expect, test } from "bun:test";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

const entries = [
  { name: "eden-test", status: "running", id: "provider-id" },
  { name: "other", status: "future-provider-status" },
];

test("list renders sandbox names, statuses and providers", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");
    options.env.EDEN_SBX_LIST_RESULT = JSON.stringify(entries);

    const result = await runCliWith(options, "sbx", "list");

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        "NAME       STATUS                  PROVIDER\n" +
        "eden-test  running                 docker-sbx\n" +
        "other      future-provider-status  docker-sbx\n",
      stderr: "",
    });
    expect(await sandboxCommands(directory)).toEqual([["ls", "--json"]]);
  });
});

test.each([false, true])(
  "list JSON returns normalized sandboxes with dryRun=%s",
  async (dryRun) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "running");
      options.env.EDEN_SBX_LIST_RESULT = JSON.stringify(entries);

      const result = await runCliWith(
        options,
        "sbx",
        "list",
        "--provider",
        "docker-sbx",
        "--json",
        ...(dryRun ? ["--dry-run"] : []),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        dryRun,
        sandboxes: entries.map(({ name, status }) => ({ provider: "docker-sbx", name, status })),
      });
      expect(await sandboxCommands(directory)).toEqual([["ls", "--json"]]);
    });
  },
);

test.each([false, true])("empty list is useful with json=%s", async (json) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");

    const result = await runCliWith(options, "sbx", "list", ...(json ? ["--json"] : []));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    if (json) expect(JSON.parse(result.stdout)).toEqual({ ok: true, dryRun: false, sandboxes: [] });
    else expect(result.stdout).toBe("No sandboxes found.\n");
  });
});
