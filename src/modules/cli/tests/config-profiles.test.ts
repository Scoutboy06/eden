import { expect, test } from "bun:test";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";

test("config set creates profile leaves and config get reads literal dotted keys", async () => {
  await using directory = await createTemporaryDirectory();
  const options = { cwd: directory.path, env: { XDG_CONFIG_HOME: directory.path } };
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
