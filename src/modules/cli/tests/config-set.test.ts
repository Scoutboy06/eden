import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";

test("config set creates directories and a minimal configuration, with silent success", async () => {
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

test("config set uses the home configuration fallback and reports JSON success", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = { cwd: directory, env: { HOME: directory, XDG_CONFIG_HOME: undefined } };

    const result = await runCliWith(options, "config", "set", "agent.default", "claude", "--json");
    const get = await runCliWith(options, "config", "get", "agent.default");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, dryRun: false });
    expect(get).toEqual({ exitCode: 0, stdout: "claude\n", stderr: "" });
    expect(await Bun.file(join(directory, ".config", "eden", "config.yaml")).exists()).toBe(true);
  });
});

for (const text of [
  "# header\nagent:\n    default: 'codex'  # keep agent\n\nworktree_root : '/unchanged' # keep root\n",
  "{ agent: { default: codex }, worktree_root: '/unchanged' } # keep\n",
  "agent: {default: codex,} # keep\nworktree_root: /unchanged\n",
  "agent:\r\n    default: codex # keep\r\nworktree_root: /unchanged\r\n",
]) {
  test(`config set preserves unrelated formatting and comments in ${JSON.stringify(text)}`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "eden", "config.yaml");
      await mkdir(join(directory, "eden"));
      await writeFile(path, text);

      const result = await runCliWith(
        { cwd: directory, env: { XDG_CONFIG_HOME: directory } },
        "config",
        "set",
        "agent.default",
        "claude",
      );

      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(await readFile(path, "utf8")).toBe(text.replace("codex", "claude"));
    });
  });
}

for (const text of [
  "# header\nworktree_root : '/unchanged' # keep root\n",
  "agent: {} # keep\nworktree_root : '/unchanged' # keep root\n",
  "{worktree_root: /unchanged, } # keep\n",
]) {
  test(`config set adds missing mappings or settings in ${JSON.stringify(text)}`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "eden", "config.yaml");
      await mkdir(join(directory, "eden"));
      await writeFile(path, text);

      const result = await runCliWith(
        { cwd: directory, env: { XDG_CONFIG_HOME: directory } },
        "config",
        "set",
        "agent.default",
        "claude",
      );
      const edited = await readFile(path, "utf8");

      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(Bun.YAML.parse(edited)).toEqual({
        agent: { default: "claude" },
        worktree_root: "/unchanged",
      });
      expect(edited).toContain(
        text.includes("# keep root") ? "worktree_root : '/unchanged' # keep root" : "# keep",
      );
    });
  });
}

for (const value of [
  "~/trees/../worktrees",
  "/trees: with spaces/#literal",
  "/true",
  "/[literal]",
]) {
  test(`config set stores the supplied string without normalization or YAML interpretation: ${value}`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const options = { cwd: directory, env: { HOME: directory, XDG_CONFIG_HOME: directory } };

      const result = await runCliWith(options, "config", "set", "worktree_root", value);
      const text = await readFile(join(directory, "eden", "config.yaml"), "utf8");
      const get = await runCliWith(options, "config", "get", "worktree_root", "--json");

      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(Bun.YAML.parse(text)).toEqual({ worktree_root: value });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout).value).toBe(
        value.startsWith("~/") ? join(directory, "worktrees") : value,
      );
    });
  });
}

for (const [key, value, code] of [
  ["agent.typo", "claude", "CONFIG_KEY_UNKNOWN"],
  ["__proto__", "claude", "CONFIG_KEY_UNKNOWN"],
  ["agent", "{default: claude}", "CONFIG_KEY_NOT_LEAF"],
  ["agent.default", "unsupported", "CONFIG_SCHEMA_INVALID"],
  ["agent.default", "null", "CONFIG_SCHEMA_INVALID"],
  ["agent.default", "", "CONFIG_SCHEMA_INVALID"],
  ["worktree_root", "relative", "CONFIG_SCHEMA_INVALID"],
] as const) {
  test(`config set rejects ${key}=${value} without modifying files`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "eden", "config.yaml");
      const text = "# unchanged\nagent:\n  default: codex\n";
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
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).error.code).toBe(code);
      expect(await readFile(path, "utf8")).toBe(text);
    });
  });
}

for (const [text, code] of [
  ["agent: [", "CONFIG_YAML_INVALID"],
  ["agent:\n  default: unsupported\n", "CONFIG_SCHEMA_INVALID"],
  ["# empty\n", "CONFIG_EMPTY"],
] as const) {
  test(`config set validates existing ${code} before editing`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "eden", "config.yaml");
      await mkdir(join(directory, "eden"));
      await writeFile(path, text);

      const result = await runCliWith(
        { cwd: directory, env: { XDG_CONFIG_HOME: directory } },
        "config",
        "set",
        "agent.default",
        "claude",
        "--json",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).error.code).toBe(code);
      expect(await readFile(path, "utf8")).toBe(text);
    });
  });
}

test("config set dry-run plans a validated change without creating directories", async () => {
  await withTemporaryDirectory(async (directory) => {
    const xdg = join(directory, "missing");
    const options = { cwd: directory, env: { XDG_CONFIG_HOME: xdg } };

    const result = await runCliWith(
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
    const invalid = await runCliWith(
      options,
      "config",
      "set",
      "agent.default",
      "invalid",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
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
      stderr: "",
      stdout: '[dry-run] Set configuration agent.default to "claude"\n',
    });
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout).error.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(await readdir(directory)).toEqual([]);
  });
});

test("config set dry-run leaves existing YAML untouched", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "eden", "config.yaml");
    const text = "agent:\n  default: codex # keep\n";
    await mkdir(join(directory, "eden"));
    await writeFile(path, text);

    const result = await runCliWith(
      { cwd: directory, env: { XDG_CONFIG_HOME: directory } },
      "config",
      "set",
      "agent.default",
      "claude",
      "--dry-run",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(await readFile(path, "utf8")).toBe(text);
  });
});
