import { expect, test } from "bun:test";
import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli } from "./support/sandbox";

const linkName = "sboxd-fafa863a";

async function prepareWindowsHost(directory: string) {
  const options = await prepareSandboxCli(directory, "running");
  const localAppData = join(directory, "local");
  const stateDir = join(localAppData, "DockerSandboxes", "sandboxes", "state", "sandboxd");
  const temp = join(localAppData, "Temp");
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(temp, "1"), { recursive: true });
  await symlink(stateDir, join(temp, "1", linkName), "junction");

  return {
    stateDir,
    temp,
    options: {
      ...options,
      env: { ...options.env, LOCALAPPDATA: localAppData, TEMP: join(temp, "1") },
    },
  };
}

test.skipIf(process.platform !== "win32")(
  "doctor lists a missing link and exits non-zero, then --fix recreates it",
  async () => {
    await using directory = await createTemporaryDirectory();
    const { options, stateDir, temp } = await prepareWindowsHost(directory.path);

    const check = await runCliWith(options, "sbx", "doctor");

    expect(check.exitCode).toBe(1);
    expect(check.stdout).toContain(`missing      ${join(temp, linkName)}`);
    expect(check.stdout).toContain("eden sbx doctor --fix");

    const fixed = await runCliWith(options, "sbx", "doctor", "--fix", "--json");

    expect(fixed.exitCode).toBe(0);
    expect(JSON.parse(fixed.stdout)).toMatchObject({
      healthy: true,
      links: [
        { path: join(temp, linkName), status: "created" },
        { path: join(temp, "1", linkName), status: "ok" },
      ],
    });
    expect((await lstat(join(temp, linkName))).isSymbolicLink()).toBe(true);
    expect((await readlink(join(temp, linkName))).replace(/[\\/]+$/, "")).toBe(stateDir);
  },
);

test.skipIf(process.platform === "win32")("doctor says it does not apply off Windows", async () => {
  await using directory = await createTemporaryDirectory();
  const options = await prepareSandboxCli(directory.path, "running");

  const result = await runCliWith(options, "sbx", "doctor");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("does not apply");
});
