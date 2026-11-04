import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { selectConfig } from "../select";
import { createConfigHarness } from "./support/config";

test("profile edits round-trip independently dotted profile and argument names", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const { config } = createConfigHarness(path);
    const key = 'sandbox.profiles["work.profile"].kit_args["inetsbx.workspace"]';

    await config.set(key, "clone");
    const value = await config.read();

    expect(selectConfig(value, key)).toBe("clone");
    expect(selectConfig(value, 'sandbox.profiles["work.profile"]')).toEqual({
      kit_args: { "inetsbx.workspace": "clone" },
    });
    expect(Bun.YAML.parse(await readFile(path, "utf8"))).toEqual({
      sandbox: { profiles: { "work.profile": { kit_args: { "inetsbx.workspace": "clone" } } } },
    });
  });
});
