import { expect, test } from "bun:test";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.each([undefined, "custom/image:tag"])(
  "create creates without attaching, image=%s",
  async (image) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      if (image !== undefined) options.env.EDEN_SBX_RUN_IMAGE = image;

      const result = await runCliWith(
        options,
        "sbx",
        "create",
        "--name",
        "example",
        ...(image === undefined ? [] : ["--image", image]),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created sandbox example");
      expect(await sandboxCommands(directory)).toEqual([
        ["ls", "--format", "json"],
        ["policy", "ls", "--json"],
        [
          "create",
          "--name",
          "example",
          ...(image === undefined ? [] : ["--template", image]),
          "--skills",
          "off",
          "shell",
        ],
      ]);
    });
  },
);

test.each(["provider creation failed", "Sandbox 'example' already exists"])(
  "create preserves failures without retrying: %s",
  async (diagnostic) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      options.env.EDEN_SBX_CREATE_FAILURE = diagnostic;

      const result = await runCliWith(options, "sbx", "create", "--name", "example");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        diagnostic.includes("already exists") ? "already exists" : diagnostic,
      );
      expect(await sandboxCommands(directory)).toEqual([
        ["ls", "--format", "json"],
        ["policy", "ls", "--json"],
        ["create", "--name", "example", "--skills", "off", "shell"],
      ]);
    });
  },
);

test("failed creation preflight never creates", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    options.env.EDEN_SBX_POLICY_FAILURE = "global network policy has not been initialized";

    const result = await runCliWith(
      options,
      "sbx",
      "create",
      "--name",
      "example",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "SANDBOX_NETWORK_POLICY_REQUIRED" },
    });
    expect(await sandboxCommands(directory)).toEqual([
      ["ls", "--format", "json"],
      ["policy", "ls", "--json"],
    ]);
  });
});
