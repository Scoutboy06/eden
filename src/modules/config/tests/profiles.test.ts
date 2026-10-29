import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { createFileConfigService } from "../config.service";
import { selectConfig } from "../select";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";

test("reads profiles without interpreting references or injecting profile defaults", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const profiles = {
      inet: {
        provider: "docker-sbx" as const,
        template: "prodinetcrsweccr.azurecr.io/inetsbx:latest",
        kits: [
          "~/kit",
          "./kit",
          "C:\\work\\kit",
          "oci://registry/kit",
          "https://example.com/kit.git",
        ],
        kit_args: { "inetsbx.workspace": "clone", enabled: true, count: 3, empty: "" },
      },
      empty: {},
      "work.profile": { kits: [], kit_args: {} },
      "with spaces": { template: "opaque template reference" },
    };
    await writeFile(path, stringify({ sandbox: { profiles } }));

    const config = await createFileConfigService({ pathsLowToHigh: [path] }).read();

    expect(config.sandbox).toEqual({ profiles });
  });
});

test.each([
  [[], "sandbox.profiles"],
  [{ "": {} }, 'sandbox.profiles[""]'],
  [{ unused: { unknown: true } }, "sandbox.profiles.unused.unknown"],
  [{ unused: { provider: "invalid" } }, "sandbox.profiles.unused.provider"],
  [{ unused: { template: "" } }, "sandbox.profiles.unused.template"],
  [{ unused: { template: 3 } }, "sandbox.profiles.unused.template"],
  [{ unused: { kits: "kit" } }, "sandbox.profiles.unused.kits"],
  [{ unused: { kits: [""] } }, "sandbox.profiles.unused.kits.0"],
  [{ unused: { kit_args: [] } }, "sandbox.profiles.unused.kit_args"],
  [{ unused: { kit_args: { "": "value" } } }, 'sandbox.profiles.unused.kit_args[""]'],
  [{ unused: { kit_args: { "kit.arg": null } } }, 'sandbox.profiles.unused.kit_args["kit.arg"]'],
  [{ unused: { kit_args: { arg: [] } } }, "sandbox.profiles.unused.kit_args.arg"],
  [{ unused: { kit_args: { arg: {} } } }, "sandbox.profiles.unused.kit_args.arg"],
  [{ unused: [] }, "sandbox.profiles.unused"],
  [{ unused: null }, "sandbox.profiles.unused"],
] as const)("rejects invalid profile configuration %j", async (profiles, issuePath) => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, stringify({ sandbox: { profiles } }));

    await expect(createFileConfigService({ pathsLowToHigh: [path] }).read()).rejects.toMatchObject({
      code: "CONFIG_SCHEMA_INVALID",
      path,
      issues: expect.arrayContaining([expect.objectContaining({ path: issuePath })]),
    });
  });
});

test("merges profile fields and argument keys, replaces arrays, and preserves provenance", async () => {
  await withTemporaryDirectory(async (directory) => {
    const global = join(directory, "global.yaml");
    const repository = join(directory, "repository.yaml");
    const local = join(directory, "local.yaml");
    await writeFile(
      global,
      stringify({
        sandbox: {
          profiles: {
            inet: {
              provider: "docker-sbx",
              template: "global:image",
              kits: ["first", "second"],
              kit_args: { "kit.arg": "global", enabled: true, count: 1 },
            },
            "other.profile": { template: "other:image" },
          },
        },
      }),
    );
    await writeFile(
      repository,
      stringify({
        sandbox: {
          profiles: {
            inet: {
              template: "repository:image",
              kits: ["replacement"],
              kit_args: { "kit.arg": "repository", count: 2 },
            },
          },
        },
      }),
    );
    await writeFile(
      local,
      stringify({ sandbox: { profiles: { inet: { kit_args: {} }, "other.profile": {} } } }),
    );

    const { config, provenance } = await createFileConfigService({
      pathsLowToHigh: [global, repository, local],
    }).readWithProvenance();

    expect(config.sandbox?.profiles).toEqual({
      inet: {
        provider: "docker-sbx",
        template: "repository:image",
        kits: ["replacement"],
        kit_args: { "kit.arg": "repository", enabled: true, count: 2 },
      },
      "other.profile": { template: "other:image" },
    });
    expect(provenance).toMatchObject({
      "sandbox.profiles.inet.provider": { type: "file", path: global },
      "sandbox.profiles.inet.template": { type: "file", path: repository },
      "sandbox.profiles.inet.kits": { type: "file", path: repository },
      'sandbox.profiles.inet.kit_args["kit.arg"]': { type: "file", path: repository },
      "sandbox.profiles.inet.kit_args.enabled": { type: "file", path: global },
      "sandbox.profiles.inet.kit_args.count": { type: "file", path: repository },
      'sandbox.profiles["other.profile"].template': { type: "file", path: global },
    });
  });
});

test("rejects invalid profile fields in lower layers even when overridden", async () => {
  await withTemporaryDirectory(async (directory) => {
    const global = join(directory, "global.yaml");
    const repository = join(directory, "repository.yaml");
    await writeFile(global, "sandbox:\n  profiles:\n    inet:\n      template: 123\n");
    await writeFile(repository, "sandbox:\n  profiles:\n    inet:\n      template: valid\n");

    await expect(
      createFileConfigService({ pathsLowToHigh: [global, repository] }).read(),
    ).rejects.toMatchObject({
      code: "CONFIG_SCHEMA_INVALID",
      path: global,
    });
  });
});

test.each(["__proto__", "constructor", "prototype", "toString"])(
  "preserves literal mapping key %s safely",
  async (key) => {
    await withTemporaryDirectory(async (directory) => {
      const global = join(directory, "global.yaml");
      const repository = join(directory, "repository.yaml");
      await writeFile(
        global,
        stringify({ sandbox: { profiles: { [key]: { kit_args: { [key]: "global" } } } } }),
      );
      await writeFile(
        repository,
        stringify({
          sandbox: { profiles: { [key]: { kit_args: { [key]: "override" }, template: "image" } } },
        }),
      );

      const { config, provenance } = await createFileConfigService({
        pathsLowToHigh: [global, repository],
      }).readWithProvenance();
      const path = `sandbox.profiles[${JSON.stringify(key)}].kit_args[${JSON.stringify(key)}]`;

      expect(selectConfig(config, path)).toBe("override");
      expect(Object.keys(config.sandbox!.profiles!)).toEqual([key]);
      expect(provenance[`sandbox.profiles.${key}.kit_args.${key}`]).toEqual({
        type: "file",
        path: repository,
      });
      expect(Object.hasOwn(Object.prototype, "kit_args")).toBe(false);
    });
  },
);
