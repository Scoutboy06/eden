import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileConfigService } from "../config.service";
import { createExecution } from "../../execution";
import { rootPrefix } from "./support/root";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";

test("merges layers without letting defaults or empty mappings replace configured leaves", async () => {
  await withTemporaryDirectory(async (directory) => {
    const global = join(directory, "global.yaml");
    const repository = join(directory, "repository.yaml");
    const local = join(directory, "local.yaml");
    await writeFile(global, "agent:\n  default: claude\nworktree_root: ~/custom\n");
    await writeFile(repository, "agent: {}\n");
    await writeFile(local, "agent:\n  default: opencode\n");
    const service = createFileConfigService({ pathsLowToHigh: [global, repository, local] });

    const resolved = await service.readWithProvenance();

    expect(resolved).toEqual({
      config: { agent: { default: "opencode" }, worktree_root: join(homedir(), "custom") },
      provenance: {
        "agent.default": { type: "file", path: local },
        worktree_root: { type: "file", path: global },
      },
    });
    expect(await service.read()).toEqual(resolved.config);
  });
});

test("reports defaults and skips missing layers without creating files", async () => {
  await withTemporaryDirectory(async (directory) => {
    const global = join(directory, "global.yaml");
    const local = join(directory, "local.yaml");
    const service = createFileConfigService({ pathsLowToHigh: [global, local] });

    expect(await service.readWithProvenance()).toEqual({
      config: { worktree_root: join(homedir(), ".worktrees") },
      provenance: { worktree_root: { type: "default" } },
    });
    expect(await Bun.file(global).exists()).toBe(false);
    expect(await Bun.file(local).exists()).toBe(false);
  });
});

test.each([false, true])(
  "writes only the global layer and preserves comments with dryRun=%s",
  async (dryRun) => {
    await withTemporaryDirectory(async (directory) => {
      const global = join(directory, "global.yaml");
      const local = join(directory, "local.yaml");
      const original = "# Global settings\nagent:\n  default: claude\n";
      const override = "agent:\n  default: opencode\n";
      await writeFile(global, original);
      await writeFile(local, override);
      const execution = createExecution({ dryRun });
      const service = createFileConfigService({ pathsLowToHigh: [global, local], execution });

      await service.set("agent.default", "codex");

      expect(await Bun.file(global).text()).toBe(
        dryRun ? original : original.replace("claude", "codex"),
      );
      expect(await Bun.file(local).text()).toBe(override);
      expect((await service.read()).agent?.default).toBe("opencode");
      expect(execution.operations).toMatchObject([{ input: { path: global } }]);
    });
  },
);

test.each([
  ["agent:\n  default: invalid\n", "CONFIG_SCHEMA_INVALID"],
  ["agent: [", "CONFIG_YAML_INVALID"],
  ["# empty", "CONFIG_EMPTY"],
] as const)("rejects invalid lower layers even when overridden: %s", async (text, code) => {
  await withTemporaryDirectory(async (directory) => {
    const global = join(directory, "global.yaml");
    const local = join(directory, "local.yaml");
    await writeFile(global, text);
    await writeFile(local, "agent:\n  default: claude\n");
    const service = createFileConfigService({ pathsLowToHigh: [global, local] });

    await expect(service.readWithProvenance()).rejects.toMatchObject({ code, path: global });
  });
});

test("uses explicit repository context rather than the working directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = join(directory, "repository");
    const configHome = join(directory, "xdg");
    await mkdir(join(repository, ".eden"), { recursive: true });
    await mkdir(join(configHome, "eden"), { recursive: true });
    await writeFile(
      join(configHome, "eden", "config.yaml"),
      `worktree_root: ${rootPrefix}/global\n`,
    );
    await writeFile(
      join(repository, ".eden", "config.yaml"),
      `worktree_root: ${rootPrefix}/repository\n`,
    );
    await writeFile(join(repository, ".eden", "config.local.yaml"), "agent:\n  default: claude\n");

    for (const explicit of [false, true]) {
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("./fixtures/read.ts", import.meta.url)),
          ...(explicit ? [repository] : []),
        ],
        {
          cwd: repository,
          env: { ...process.env, XDG_CONFIG_HOME: configHome },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual(
        explicit
          ? { worktree_root: normalize(`${rootPrefix}/repository`), agent: { default: "claude" } }
          : { worktree_root: normalize(`${rootPrefix}/global`) },
      );
    }
  });
});
