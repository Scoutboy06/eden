import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.each(["create", "run"])(
  "sbx %s forwards profile kits and literal arguments to Docker",
  async (command) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      const flags = [
        "--kit",
        "~/missing kit",
        "--kit",
        "C:\\work\\kit",
        "--kit",
        "oci://example.com/team:latest",
        "--kit-arg",
        "team.name=${sandbox.name}",
        "--kit-arg",
        "text=a=b with 'quotes' and $(literal)",
        "--kit-arg",
        "enabled=true",
        "--kit-arg",
        "disabled=false",
        "--kit-arg",
        "count=3",
        "--kit-arg",
        "empty=",
        "--kit-arg",
        "identifier=00123",
      ];
      options.env.EDEN_SBX_RUN_KIT_FLAGS = JSON.stringify(flags);
      options.env.EDEN_SBX_RUN_IMAGE = "profile:image";
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            profiles: {
              work: {
                provider: "docker-sbx",
                template: "profile:image",
                kits: ["~/missing kit", "C:\\work\\kit", "oci://example.com/team:latest"],
                kit_args: {
                  "team.name": "${sandbox.name}",
                  text: "a=b with 'quotes' and $(literal)",
                  enabled: true,
                  disabled: false,
                  count: 3,
                  empty: "",
                  identifier: "00123",
                },
              },
            },
          },
        }),
      );

      const result = await runCliWith(
        options,
        "sbx",
        command,
        "--name",
        "example",
        "--profile",
        "work",
      );

      expect(result.exitCode).toBe(0);
      expect(await sandboxCommands(directory)).toEqual([
        ...(command === "run" ? [["ls", "--format", "json"]] : []),
        ["ls", "--format", "json"],
        ["policy", "ls", "--json"],
        [
          "create",
          "--name",
          "example",
          "--template",
          "profile:image",
          ...flags,
          "--skills",
          "off",
          "shell",
        ],
        ...(command === "run" ? [["run", "--name", "example"]] : []),
      ]);
    });
  },
);

test.each(["create", "run"])(
  "sbx %s dry-run reports kit references and typed arguments without creating",
  async (command) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      const kits = ["./does-not-exist", "~/team kit"];
      const kitArgs = { "team.name": "${sandbox.name}", enabled: true, count: 3, empty: "" };
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            profiles: { work: { provider: "docker-sbx", kits, kit_args: kitArgs } },
          },
        }),
      );

      const result = await runCliWith(
        options,
        "sbx",
        command,
        "--name",
        "example",
        "--profile",
        "work",
        "--dry-run",
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).operations[0]).toMatchObject({
        type: "sandbox.create",
        input: { provider: "docker-sbx", name: "example", profile: "work", kits, kitArgs },
      });
      expect(await sandboxCommands(directory)).toEqual([
        ...(command === "run" ? [["ls", "--format", "json"]] : []),
        ["ls", "--format", "json"],
        ["policy", "ls", "--json"],
      ]);
    });
  },
);

test.each(["create", "run"])(
  "sbx %s preserves Docker kit errors without attachment or cleanup",
  async (command) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      options.env.EDEN_SBX_RUN_KIT_FLAGS = JSON.stringify(["--kit", "./missing-kit"]);
      options.env.EDEN_SBX_CREATE_FAILURE = "kit reference not found: ./missing-kit";
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: {
            profiles: { work: { provider: "docker-sbx", kits: ["./missing-kit"] } },
          },
        }),
      );

      const result = await runCliWith(
        options,
        "sbx",
        command,
        "--name",
        "example",
        "--profile",
        "work",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(options.env.EDEN_SBX_CREATE_FAILURE!);
      expect(await sandboxCommands(directory)).toEqual([
        ...(command === "run" ? [["ls", "--format", "json"]] : []),
        ["ls", "--format", "json"],
        ["policy", "ls", "--json"],
        ["create", "--name", "example", "--kit", "./missing-kit", "--skills", "off", "shell"],
      ]);
    });
  },
);

test("profiles can pass kit arguments without explicitly selecting kits", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    options.env.EDEN_SBX_RUN_KIT_FLAGS = JSON.stringify(["--kit-arg", "bundled.enabled=true"]);
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          profiles: { work: { provider: "docker-sbx", kit_args: { "bundled.enabled": true } } },
        },
      }),
    );

    const result = await runCliWith(
      options,
      "sbx",
      "create",
      "--name",
      "example",
      "--profile",
      "work",
    );

    expect(result.exitCode).toBe(0);
    expect((await sandboxCommands(directory)).at(-1)).toEqual([
      "create",
      "--name",
      "example",
      "--kit-arg",
      "bundled.enabled=true",
      "--skills",
      "off",
      "shell",
    ]);
  });
});
