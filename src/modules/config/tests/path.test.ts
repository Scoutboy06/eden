import { expect, test } from "bun:test";
import { formatConfigPath, parseConfigPath } from "../path";
import { configLeafPath, selectConfig } from "../select";

test.each([
  ["sandbox.profiles.inet.template", ["sandbox", "profiles", "inet", "template"]],
  [
    'sandbox.profiles.inet.kit_args["inetsbx.workspace"]',
    ["sandbox", "profiles", "inet", "kit_args", "inetsbx.workspace"],
  ],
  [
    'sandbox.profiles["work.profile"].template',
    ["sandbox", "profiles", "work.profile", "template"],
  ],
  [
    '["sandbox"]["profiles"]["a\\\"b\\\\c"].template',
    ["sandbox", "profiles", 'a"b\\c', "template"],
  ],
  [
    'sandbox.profiles["with space"].kit_args["x[y]"]',
    ["sandbox", "profiles", "with space", "kit_args", "x[y]"],
  ],
  ['sandbox.profiles["\\u0061"].template', ["sandbox", "profiles", "a", "template"]],
] as const)("parses config path %s", (path, keys) => {
  expect(parseConfigPath(path)).toEqual([...keys]);
  expect(parseConfigPath(formatConfigPath(keys))).toEqual([...keys]);
});

test.each([
  "",
  ".sandbox",
  "sandbox.",
  "sandbox..profiles",
  "sandbox[0]",
  "sandbox['profiles']",
  'sandbox["profiles"',
  'sandbox["profiles"]extra',
  'sandbox.["profiles"]',
  'sandbox[""]',
  'sandbox["bad\\q"]',
  'sandbox["raw\nline"]',
  "sandbox.profiles.work\\.profile",
  "sandbox.profiles.inet.kits[0]",
  "sandbox.profiles.inet.typo",
  "__proto__",
])("rejects invalid or unknown config path %j", (path) => {
  expect(() => selectConfig({ worktree_root: "/trees" }, path)).toThrow(
    expect.objectContaining({ code: "CONFIG_KEY_UNKNOWN" }),
  );
});

test.each([
  "sandbox",
  "sandbox.profiles",
  "sandbox.profiles.inet",
  "sandbox.profiles.inet.kit_args",
  "sandbox.profiles.inet.kits",
])("rejects non-scalar writes at %s", (path) => {
  expect(() => configLeafPath(path)).toThrow(
    expect.objectContaining({ code: "CONFIG_KEY_NOT_LEAF" }),
  );
});

test("selects scalar and collection values without traversing inherited properties", () => {
  const config = {
    worktree_root: "/trees",
    sandbox: {
      profiles: {
        inet: {
          kits: ["~/kit"],
          kit_args: { "inetsbx.workspace": "clone", enabled: true, count: 3 },
        },
      },
    },
  };

  expect(selectConfig(config, 'sandbox.profiles.inet.kit_args["inetsbx.workspace"]')).toBe("clone");
  expect(selectConfig(config, "sandbox.profiles.inet.kit_args.enabled")).toBe(true);
  expect(selectConfig(config, "sandbox.profiles.inet.kit_args.count")).toBe(3);
  expect(selectConfig(config, "sandbox.profiles.inet.kits")).toEqual(["~/kit"]);
  expect(selectConfig(config, "sandbox.profiles.inet")).toEqual(config.sandbox.profiles.inet);
  expect(selectConfig(config, "sandbox.profiles.constructor.template")).toBeUndefined();
  expect(selectConfig(config, "sandbox.profiles.inet.kit_args.toString")).toBeUndefined();
});
