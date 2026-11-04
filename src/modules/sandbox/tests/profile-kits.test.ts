import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxHarness } from "./support/sandbox";

test("profile kit references resolve paths and preserve literal typed arguments", async () => {
  await withTemporaryDirectory(async (directory) => {
    const kitArgs = {
      "team.name": "${sandbox.name}",
      enabled: true,
      count: 3,
      empty: "",
      identifier: "00123",
    };
    const { service, execution, commands } = await createSandboxHarness({
      directory,
      profile: "work",
      config: {
        sandbox: {
          profiles: {
            work: {
              provider: "docker-sbx",
              kits: [
                "./missing kit",
                "~/literal kit",
                "C:\\work\\kit",
                "oci://example.com/team:latest",
              ],
              kit_args: kitArgs,
            },
          },
        },
      },
    });

    await service.create({ name: "example" });

    expect(execution.operations[0]?.input).toMatchObject({
      kits: [
        resolve("missing kit"),
        join(homedir(), "literal kit"),
        "C:\\work\\kit",
        "oci://example.com/team:latest",
      ],
      kitArgs,
    });
    expect(commands.at(-1)?.args).toContain("team.name=${sandbox.name}");
    expect(commands.at(-1)?.args).toContain("identifier=00123");
  });
});

test("kit creation failures preserve diagnostics without attachment or cleanup", async () => {
  await withTemporaryDirectory(async (directory) => {
    const kit = join(directory, "missing-kit");
    const { service, commands } = await createSandboxHarness({
      directory,
      profile: "work",
      config: { sandbox: { default_provider: "docker-sbx", profiles: { work: { kits: [kit] } } } },
      run: async (args) =>
        args[0] === "create"
          ? { exitCode: 1, stdout: "", stderr: "kit reference not found: ./missing-kit" }
          : { exitCode: 0, stdout: args[0] === "ls" ? "[]" : "", stderr: "" },
    });

    await expect(service.create({ name: "example" })).rejects.toMatchObject({
      code: "SANDBOX_CREATE_FAILED",
      message: expect.stringContaining("kit reference not found: ./missing-kit"),
    });
    expect(commands.map(({ args }) => args)).toEqual([
      ["ls", "--json"],
      ["policy", "ls", "--json"],
      ["create", "--name", "example", "--kit", kit, "--skills", "off", "--no-progress", "shell"],
    ]);
  });
});

test("profile kit arguments are passed without explicitly selecting kits", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, commands } = await createSandboxHarness({
      directory,
      profile: "work",
      config: {
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { work: { kit_args: { "bundled.enabled": true } } },
        },
      },
    });

    await service.create({ name: "example" });

    expect(commands.map(({ args }) => args)).toEqual([
      ["ls", "--json"],
      ["policy", "ls", "--json"],
      [
        "create",
        "--name",
        "example",
        "--kit-arg",
        "bundled.enabled=true",
        "--skills",
        "off",
        "--no-progress",
        "shell",
      ],
    ]);
  });
});
