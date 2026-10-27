import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

const preflight = [
  ["ls", "--format", "json"],
  ["ls", "--format", "json"],
  ["policy", "ls", "--json"],
];

test.each(["default", "custom"])(
  "run creates a missing sandbox with %s image before attaching",
  async (choice) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      const imageArgs = choice === "custom" ? ["--image", "custom/image:tag"] : [];
      if (choice === "custom") options.env.EDEN_SBX_RUN_IMAGE = "custom/image:tag";

      const result = await runCliWith(options, "sbx", "run", "--name", "example", ...imageArgs);

      expect(result).toEqual({
        exitCode: 0,
        stdout: "created\nattached\n",
        stderr: "provider stderr\n",
      });
      expect(await sandboxCommands(directory)).toEqual([
        ...preflight,
        [
          "create",
          "--name",
          "example",
          ...(choice === "custom" ? ["--template", "custom/image:tag"] : []),
          "--skills",
          "off",
          "shell",
        ],
        ["run", "--name", "example"],
      ]);
    });
  },
);

test.each(["default", "custom"])(
  "run previews creation and attachment with %s image",
  async (choice) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      const imageArgs = choice === "custom" ? ["--image", "custom/image:tag"] : [];

      const result = await runCliWith(
        options,
        "sbx",
        "run",
        "--name",
        "example",
        ...imageArgs,
        "--dry-run",
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        dryRun: true,
        operations: [
          {
            type: "sandbox.create",
            description: "Create sandbox example using docker-sbx",
            input: {
              provider: "docker-sbx",
              name: "example",
              ...(choice === "custom" ? { image: "custom/image:tag" } : {}),
            },
          },
          {
            type: "sandbox.run",
            description: "Attach to sandbox example using docker-sbx",
            input: { provider: "docker-sbx", name: "example" },
          },
        ],
      });
      expect(await sandboxCommands(directory)).toEqual(preflight);
    });
  },
);

test.each([false, true])(
  "run refuses an unverifiable image for an existing sandbox, dryRun=%s",
  async (dryRun) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "stopped");

      const result = await runCliWith(
        options,
        "sbx",
        "run",
        "--name",
        "example",
        "--image",
        "custom/image:tag",
        ...(dryRun ? ["--dry-run", "--json"] : []),
      );

      expect(result.exitCode).toBe(1);
      if (dryRun)
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { code: "SANDBOX_INVALID_INPUT" },
        });
      else expect(result.stderr).toContain("omit --image to attach");
      expect(await sandboxCommands(directory)).toEqual([["ls", "--format", "json"]]);
    });
  },
);

test.each(["provider creation failed", "Sandbox 'example' already exists"])(
  "failed creation never attaches or retries: %s",
  async (diagnostic) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      options.env.EDEN_SBX_CREATE_FAILURE = diagnostic;

      const result = await runCliWith(options, "sbx", "run", "--name", "example");

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        diagnostic.includes("already exists") ? "already exists" : diagnostic,
      );
      expect(await sandboxCommands(directory)).toEqual([
        ...preflight,
        ["create", "--name", "example", "--skills", "off", "shell"],
      ]);
    });
  },
);

test("failed creation preflight never creates or attaches", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    options.env.EDEN_SBX_POLICY_FAILURE = "global network policy has not been initialized";

    const result = await runCliWith(
      options,
      "sbx",
      "run",
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
    expect(await sandboxCommands(directory)).toEqual(preflight);
  });
});

test.each([{ args: ["--name", " "] }, { args: ["--name", "example", "--image", " "] }])(
  "run rejects empty creation input before provider calls: %p",
  async ({ args }) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");

      const result = await runCliWith(options, "sbx", "run", ...args);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("must not be empty");
      expect(await Bun.file(join(directory, "commands")).exists()).toBe(false);
    });
  },
);
