import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

const entries = [
  { name: "eden-test", status: "running", id: "provider-id" },
  { name: "other", status: "future-provider-status" },
];

test("list renders sandbox names, statuses and providers", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "running");
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
  expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
});

test.each([false, true])(
  "list JSON returns normalized sandboxes with dryRun=%s",
  async (dryRun) => {
    await using directory = await createTemporaryDirectory();
    const options = await prepareSandboxCli(directory.path, "running");
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
    expect(await sandboxCommands(directory.path)).toEqual([["ls", "--json"]]);
  },
);

test.each([false, true])("empty list is useful with json=%s", async (json) => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "missing");

  const result = await runCliWith(options, "sbx", "list", ...(json ? ["--json"] : []));

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  if (json) expect(JSON.parse(result.stdout)).toEqual({ ok: true, dryRun: false, sandboxes: [] });
  else expect(result.stdout).toBe("No sandboxes found.\n");
});

test("list shows the profile a sandbox was created with", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "running");
  options.env.EDEN_SBX_LIST_RESULT = JSON.stringify(entries);
  await Bun.write(
    join(options.env.XDG_STATE_HOME!, "eden", "sandbox-profiles.json"),
    JSON.stringify({
      "docker-sbx": { "eden-test": { profile: "work", recordedAt: "2026-11-14T10:00:00.000Z" } },
    }),
  );

  const human = await runCliWith(options, "sbx", "list");
  const json = await runCliWith(options, "sbx", "list", "--json");

  expect(human.stdout).toBe(
    "NAME       STATUS                  PROVIDER    PROFILE\n" +
      "eden-test  running                 docker-sbx  work\n" +
      "other      future-provider-status  docker-sbx  -\n",
  );
  expect(JSON.parse(json.stdout).sandboxes[0]).toEqual({
    provider: "docker-sbx",
    name: "eden-test",
    status: "running",
    profile: "work",
  });
});
