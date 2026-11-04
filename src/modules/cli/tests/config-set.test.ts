import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";

test("config set creates a minimal configuration and keeps successful CLI output silent", async () => {
  await withTemporaryDirectory(async (directory) => {
    const xdg = join(directory, "missing", "config");
    const path = join(xdg, "eden", "config.yaml");
    const result = await runCliWith(
      { cwd: directory, env: { XDG_CONFIG_HOME: xdg } },
      "config",
      "set",
      "agent.default",
      "claude",
    );

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(await readFile(path, "utf8")).toBe("agent:\n  default: claude\n");
  });
});

test("config set reports validation errors in human and JSON forms without modifying the file", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "eden", "config.yaml");
    const text = "# unchanged\nagent:\n  default: codex\n";
    await Bun.write(path, text);

    const human = await runCliWith(
      { cwd: directory, env: { XDG_CONFIG_HOME: directory } },
      "config",
      "set",
      "agent.default",
      "unsupported",
    );
    const json = await runCliWith(
      { cwd: directory, env: { XDG_CONFIG_HOME: directory } },
      "config",
      "set",
      "agent.default",
      "unsupported",
      "--json",
    );

    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("agent.default: Expected codex, claude, or opencode");
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout).error).toMatchObject({
      code: "CONFIG_SCHEMA_INVALID",
      issues: [{ path: "agent.default", message: "Expected codex, claude, or opencode" }],
    });
    expect(await readFile(path, "utf8")).toBe(text);
  });
});

test("config set uses the home configuration fallback and reports JSON success", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = {
      cwd: directory,
      env: { HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: undefined },
    };

    const result = await runCliWith(options, "config", "set", "agent.default", "claude", "--json");
    const get = await runCliWith(options, "config", "get", "agent.default");

    expect(result).toEqual({ exitCode: 0, stdout: '{"ok":true,"dryRun":false}\n', stderr: "" });
    expect(get).toEqual({ exitCode: 0, stdout: "claude\n", stderr: "" });
    expect(await Bun.file(join(directory, ".config", "eden", "config.yaml")).exists()).toBe(true);
  });
});

test("config set dry-run presents JSON and human operations and does not create paths", async () => {
  await withTemporaryDirectory(async (directory) => {
    const xdg = join(directory, "missing");
    const options = { cwd: directory, env: { XDG_CONFIG_HOME: xdg } };
    const json = await runCliWith(
      options,
      "config",
      "set",
      "agent.default",
      "claude",
      "--dry-run",
      "--json",
    );
    const human = await runCliWith(
      options,
      "config",
      "set",
      "agent.default",
      "claude",
      "--dry-run",
    );

    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      dryRun: true,
      operations: [
        {
          type: "config.set",
          description: 'Set configuration agent.default to "claude"',
          input: { path: join(xdg, "eden", "config.yaml"), key: "agent.default", value: "claude" },
        },
      ],
    });
    expect(human).toEqual({
      exitCode: 0,
      stdout: '[dry-run] Set configuration agent.default to "claude"\n',
      stderr: "",
    });
    expect(await Bun.file(xdg).exists()).toBe(false);
  });
});
