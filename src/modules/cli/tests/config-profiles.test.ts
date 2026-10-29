import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";

test("config set creates profile leaves and config get reads literal dotted keys", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = { cwd: directory, env: { XDG_CONFIG_HOME: directory } };
    const key = 'sandbox.profiles["work.profile"].kit_args["inetsbx.workspace"]';

    const set = await runCliWith(options, "config", "set", key, "clone");
    const get = await runCliWith(options, "config", "get", key, "--json");
    const profile = await runCliWith(
      options,
      "config",
      "get",
      'sandbox.profiles["work.profile"]',
      "--json",
    );

    expect(set).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(get.exitCode).toBe(0);
    expect(JSON.parse(get.stdout).value).toBe("clone");
    expect(JSON.parse(profile.stdout).value).toEqual({
      kit_args: { "inetsbx.workspace": "clone" },
    });
  });
});

test.each(["__proto__", "constructor", 'quote"and\\slash'])(
  "config set safely edits literal profile and argument name %j",
  async (name) => {
    await withTemporaryDirectory(async (directory) => {
      const options = { cwd: directory, env: { XDG_CONFIG_HOME: directory } };
      const key = `sandbox.profiles[${JSON.stringify(name)}].kit_args[${JSON.stringify(name)}]`;

      const created = await runCliWith(options, "config", "set", key, "initial");
      const updated = await runCliWith(options, "config", "set", key, "updated");
      const get = await runCliWith(options, "config", "get", key, "--json");

      expect(created).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(updated).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout).value).toBe("updated");
    });
  },
);

test.each(["true", "false", "3", "00123", "null", "[1, 2]", "{x: 1}"])(
  "config set writes kit argument %j as a string, including over existing typed YAML",
  async (value) => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "eden", "config.yaml");
      const options = { cwd: directory, env: { XDG_CONFIG_HOME: directory } };
      await mkdir(join(directory, "eden"));
      await writeFile(
        path,
        "# keep\nsandbox:\n  profiles:\n    inet:\n      kit_args:\n        enabled: true # argument\n        count: 3\n",
      );

      const typed = await runCliWith(
        options,
        "config",
        "get",
        "sandbox.profiles.inet.kit_args",
        "--json",
      );
      const set = await runCliWith(
        options,
        "config",
        "set",
        "sandbox.profiles.inet.kit_args.enabled",
        value,
      );
      const text = await readFile(path, "utf8");
      const get = await runCliWith(
        options,
        "config",
        "get",
        "sandbox.profiles.inet.kit_args.enabled",
        "--json",
      );

      expect(JSON.parse(typed.stdout).value).toEqual({ enabled: true, count: 3 });
      expect(set).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(JSON.parse(get.stdout).value).toBe(value);
      expect(text).toContain("# keep");
      expect(text).toContain("# argument");
      expect(Bun.YAML.parse(text)).toEqual({
        sandbox: { profiles: { inet: { kit_args: { enabled: value, count: 3 } } } },
      });
    });
  },
);

test.each([
  ["sandbox.profiles", "{}", "CONFIG_KEY_NOT_LEAF"],
  ["sandbox.profiles.inet", "{}", "CONFIG_KEY_NOT_LEAF"],
  ["sandbox.profiles.inet.kits", "[kit]", "CONFIG_KEY_NOT_LEAF"],
  ["sandbox.profiles.inet.kit_args", "{}", "CONFIG_KEY_NOT_LEAF"],
  ["sandbox.profiles.inet.provider", "invalid", "CONFIG_SCHEMA_INVALID"],
  ["sandbox.profiles.inet.template", "", "CONFIG_SCHEMA_INVALID"],
  ['sandbox.profiles[""].template', "image", "CONFIG_KEY_UNKNOWN"],
  ['sandbox.profiles.inet.kit_args["arg]', "value", "CONFIG_KEY_UNKNOWN"],
] as const)("config set rejects %s without modifying the file", async (key, value, code) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "eden", "config.yaml");
    const text = "# unchanged\nsandbox: {}\n";
    await mkdir(join(directory, "eden"));
    await writeFile(path, text);

    const result = await runCliWith(
      { cwd: directory, env: { XDG_CONFIG_HOME: directory } },
      "config",
      "set",
      key,
      value,
      "--json",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe(code);
    expect(await readFile(path, "utf8")).toBe(text);
  });
});
