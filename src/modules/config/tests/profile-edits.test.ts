import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createFileConfigService } from "../config.service";
import { selectConfig } from "../select";
import { createExecution } from "../../execution";

test.each(["__proto__", "constructor", 'quote"and\\slash'])(
  "sets and updates literal profile and argument name %j without prototype traversal",
  async (name) => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "config.yaml");
      const service = createFileConfigService({
        pathsLowToHigh: [path],
        execution: createExecution({ dryRun: false }),
      });
      const key = `sandbox.profiles[${JSON.stringify(name)}].kit_args[${JSON.stringify(name)}]`;

      await service.set(key, "initial");
      expect(selectConfig(await service.read(), key)).toBe("initial");
      await service.set(key, "updated");

      expect(selectConfig(await service.read(), key)).toBe("updated");
      expect(Bun.YAML.parse(await readFile(path, "utf8"))).toEqual({
        sandbox: { profiles: { [name]: { kit_args: { [name]: "updated" } } } },
      });
      expect(Object.hasOwn(Object.prototype, "kit_args")).toBe(false);
    });
  },
);

test.each(["true", "false", "3", "00123", "null", "[1, 2]", "{x: 1}"])(
  "writes kit argument %j as a string while preserving existing typed YAML and comments",
  async (value) => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "config.yaml");
      const service = createFileConfigService({
        pathsLowToHigh: [path],
        execution: createExecution({ dryRun: false }),
      });
      await writeFile(
        path,
        "# keep\nsandbox:\n  profiles:\n    inet:\n      kit_args:\n        enabled: true # argument\n        count: 3\n",
      );

      expect(selectConfig(await service.read(), "sandbox.profiles.inet.kit_args")).toEqual({
        enabled: true,
        count: 3,
      });
      await service.set("sandbox.profiles.inet.kit_args.enabled", value);
      const text = await readFile(path, "utf8");

      expect(selectConfig(await service.read(), "sandbox.profiles.inet.kit_args.enabled")).toBe(
        value,
      );
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
] as const)("rejects %s without modifying the file", async (key, value, code) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const text = "# unchanged\nsandbox: {}\n";
    const service = createFileConfigService({
      pathsLowToHigh: [path],
      execution: createExecution({ dryRun: false }),
    });
    await writeFile(path, text);

    await expect(service.set(key, value)).rejects.toMatchObject({ code });

    expect(await readFile(path, "utf8")).toBe(text);
  });
});
