import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";

test("config get selects the effective tree, subtree, and scalar leaves", async () => {
  await withTemporaryDirectory(async (directory) => {
    const xdg = join(directory, "config");
    const path = join(xdg, "eden", "config.yaml");
    const text =
      "# keep this comment\nagent:\n  default: claude\nworktree_root: ~/trees/../worktrees\n";
    await mkdir(join(xdg, "eden"), { recursive: true });
    await writeFile(path, text);
    const options = { cwd: directory, env: { HOME: directory, XDG_CONFIG_HOME: xdg } };

    const whole = await runCliWith(options, "config", "get");
    const subtree = await runCliWith(options, "config", "get", "agent");
    const leaf = await runCliWith(options, "config", "get", "agent.default");
    const root = await runCliWith(options, "config", "get", "worktree_root");
    const json = await runCliWith(options, "config", "get", "--json");

    expect(whole.exitCode).toBe(0);
    expect(whole.stderr).toBe("");
    expect(Bun.YAML.parse(whole.stdout)).toEqual({
      agent: { default: "claude" },
      worktree_root: join(directory, "worktrees"),
    });
    expect(subtree.exitCode).toBe(0);
    expect(subtree.stderr).toBe("");
    expect(Bun.YAML.parse(subtree.stdout)).toEqual({ default: "claude" });
    expect(leaf).toEqual({ exitCode: 0, stdout: "claude\n", stderr: "" });
    expect(root).toEqual({ exitCode: 0, stdout: `${join(directory, "worktrees")}\n`, stderr: "" });
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      dryRun: false,
      value: { agent: { default: "claude" }, worktree_root: join(directory, "worktrees") },
    });

    for (const [key, value] of [
      ["agent", { default: "claude" }],
      ["agent.default", "claude"],
    ] as const) {
      const selected = await runCliWith(options, "config", "get", key, "--json");

      expect(selected.exitCode).toBe(0);
      expect(selected.stderr).toBe("");
      expect(JSON.parse(selected.stdout)).toEqual({ ok: true, dryRun: false, value });
    }

    expect(await readFile(path, "utf8")).toBe(text);
  });
});

test("config get uses the home configuration directory when XDG_CONFIG_HOME is unset", async () => {
  await withTemporaryDirectory(async (directory) => {
    const configDirectory = join(directory, ".config", "eden");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.yaml"), "agent:\n  default: claude\n");

    const result = await runCliWith(
      { cwd: directory, env: { HOME: directory, XDG_CONFIG_HOME: undefined } },
      "config",
      "get",
      "agent.default",
    );

    expect(result).toEqual({ exitCode: 0, stdout: "claude\n", stderr: "" });
  });
});

test("config get applies defaults without creating missing configuration", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = {
      cwd: directory,
      env: { HOME: directory, XDG_CONFIG_HOME: join(directory, "missing") },
    };

    const result = await runCliWith(options, "config", "get", "--json");
    const root = await runCliWith(options, "config", "get", "worktree_root");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      dryRun: false,
      value: { worktree_root: join(directory, ".worktrees") },
    });
    expect(root).toEqual({ exitCode: 0, stdout: `${join(directory, ".worktrees")}\n`, stderr: "" });
    expect(await readdir(directory)).toEqual([]);
  });
});

for (const text of [undefined, "agent: {}\n"]) {
  test(`config get distinguishes unset settings from unknown paths with config ${text ?? "missing"}`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const xdg = join(directory, "config");
      if (text !== undefined) {
        await mkdir(join(xdg, "eden"), { recursive: true });
        await writeFile(join(xdg, "eden", "config.yaml"), text);
      }
      const options = { cwd: directory, env: { HOME: directory, XDG_CONFIG_HOME: xdg } };

      const unset = await runCliWith(options, "config", "get", "agent.default");
      const json = await runCliWith(options, "config", "get", "agent.default", "--json");

      expect(unset).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(json.exitCode).toBe(0);
      expect(json.stderr).toBe("");
      expect(JSON.parse(json.stdout)).toEqual({ ok: true, dryRun: false, value: null });

      for (const key of [
        "unknown",
        "agent.defualt",
        "agent.default.child",
        "toString",
        "agent.__proto__",
        "agent.",
        "",
      ]) {
        const result = await runCliWith(options, "config", "get", key, "--json");

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          dryRun: false,
          error: { code: "CONFIG_KEY_UNKNOWN", message: `Unknown configuration key: ${key}` },
        });
      }

      const unknown = await runCliWith(options, "config", "get", "agent.typo");

      expect(unknown.exitCode).toBe(1);
      expect(unknown.stdout).toBe("");
      expect(unknown.stderr).toContain("Unknown configuration key: agent.typo");
    });
  });
}

for (const [text, code] of [
  ["agent: [", "CONFIG_YAML_INVALID"],
  ["agent:\n  default: unsupported\n", "CONFIG_SCHEMA_INVALID"],
  ["# empty\n", "CONFIG_EMPTY"],
] as const) {
  test(`config get rejects ${code} without modifying configuration`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "eden", "config.yaml");
      await mkdir(join(directory, "eden"));
      await writeFile(path, text!);

      const result = await runCliWith(
        { cwd: directory, env: { XDG_CONFIG_HOME: directory } },
        "config",
        "get",
        "--json",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).error.code).toBe(code);
      expect(await readFile(path, "utf8")).toBe(text);
    });
  });
}
