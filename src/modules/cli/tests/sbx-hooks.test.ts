import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith, withRunningCli } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

async function installHook(configHome: string, name: string) {
  const directory = join(configHome, "eden", "hooks");
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await copyFile(new URL("./fixtures/sandbox-hook.ts", import.meta.url), path);
  await chmod(path, 0o755);
}

test.each(["invalid", "fail"])("pre hook %s stops sandbox creation", async (mode) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    await installHook(options.env.XDG_CONFIG_HOME!, "sandbox.create.pre");
    if (mode === "invalid") options.env.EDEN_HOOK_OUTPUT = '{"overwrites":{}}';
    else options.env.EDEN_HOOK_EXIT = "4";

    const result = await runCliWith(options, "sbx", "create", "--name", "example", "--json");

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("HOOK_FAILED");
    expect(JSON.parse(result.stdout).hooks[0].stderr).toContain("diagnostic");
    expect((await sandboxCommands(directory)).map((event: any) => event.hook ?? event[0])).toEqual([
      "ls",
      "policy",
      "sandbox.create.pre",
    ]);
  });
});
