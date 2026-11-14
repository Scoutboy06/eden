import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
        ["ls", "--json"],
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
      ["ls", "--json"],
      ["policy", "ls", "--json"],
    ]);
  });
});

test("create without a name derives it from the checkout folder and says so", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing", "my-project");
    const checkout = join(directory, "My Project");
    await mkdir(join(checkout, ".git"), { recursive: true });

    const result = await runCliWith({ ...options, cwd: checkout }, "sbx", "create");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Using sandbox name my-project, derived from the current");
    expect(result.stdout).toContain("Created sandbox my-project");
    expect((await sandboxCommands(directory)).at(-1)).toEqual([
      "create",
      "--name",
      "my-project",
      "--skills",
      "off",
      "shell",
    ]);
  });
});

test("create without a name outside a checkout fails before provider calls", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");

    const result = await runCliWith(options, "sbx", "create", "--json");

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "SANDBOX_INVALID_INPUT",
      message: expect.stringContaining("--name"),
    });
    expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
  });
});
