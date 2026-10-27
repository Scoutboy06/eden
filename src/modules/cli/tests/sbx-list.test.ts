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
    expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
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
      expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
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

test.each([
  "invalid-json",
  "null",
  "{}",
  "[null]",
  '[{"name":"example"}]',
  '[{"name":123,"status":"running"}]',
  '[{"name":"example","status":null}]',
])("list rejects invalid provider listing: %s", async (listing) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");
    options.env.EDEN_SBX_LIST_RESULT = listing;

    const result = await runCliWith(options, "sbx", "list", "--json");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "SANDBOX_LOOKUP_FAILED" },
    });
    expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
  });
});

test.each([
  ["not signed in to Docker", "SANDBOX_AUTH_REQUIRED"],
  ["provider failed unexpectedly", "SANDBOX_PREFLIGHT_FAILED"],
])("list preserves structured provider failure: %s", async (diagnostic, code) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");
    options.env.EDEN_SBX_LIST_FAILURE = diagnostic;

    const result = await runCliWith(options, "sbx", "list", "--json");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code } });
    expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
  });
});
