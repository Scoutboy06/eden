import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, readdir, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createExecution } from "../../execution";
import { canCreateSymlinks } from "../../fs/tests/support/executable";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createFileConfigService } from "../config.service";
import { rootPrefix } from "./support/root";

const symlinks = await canCreateSymlinks();
const testSymlinks = test.skipIf(!symlinks);

test("new global configurations use block-style YAML", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const execution = createExecution({ dryRun: false });
    const draft = await createFileConfigService({ pathsLowToHigh: [path], execution }).editGlobal();

    await draft.save(
      { "sandbox.default_provider": "docker-sbx", worktree_root: "~/p/.worktrees" },
      async () => false,
    );

    expect(await Bun.file(path).text()).toBe(
      "sandbox:\n  default_provider: docker-sbx\nworktree_root: ~/p/.worktrees\n",
    );
  });
});

test("global draft reads the original path spelling and excludes repository values", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "global.yaml");
    const repository = join(directory, "repository.yaml");
    await writeFile(path, "worktree_root: ~/.saved\n");
    await writeFile(
      repository,
      `worktree_root: ${rootPrefix}/repository\nsandbox:\n  default_provider: docker-sbx\n`,
    );
    const execution = createExecution({ dryRun: false });
    const service = createFileConfigService({ pathsLowToHigh: [path, repository], execution });

    const draft = await service.editGlobal();

    expect(draft.get("worktree_root")).toBe("~/.saved");
    expect(draft.config.sandbox).toBeUndefined();
    expect((await service.read()).sandbox?.default_provider).toBe("docker-sbx");
  });
});

test("saves preferences together while preserving comments and unrelated settings", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "eden", "config.yaml");
    await mkdir(join(directory, "eden"));
    await writeFile(
      path,
      "# My configuration\nagent:\n  default: claude # keep this\nworktree_root: ~/.old\n",
    );
    const execution = createExecution({ dryRun: false });
    const draft = await createFileConfigService({ pathsLowToHigh: [path], execution }).editGlobal();

    const status = await draft.save(
      { "sandbox.default_provider": "docker-sbx", worktree_root: "~/.new" },
      async () => false,
    );
    const text = await Bun.file(path).text();

    expect(status).toBe("saved");
    expect(text).toContain("# My configuration");
    expect(text).toContain("# keep this");
    expect(Bun.YAML.parse(text)).toEqual({
      agent: { default: "claude" },
      worktree_root: "~/.new",
      sandbox: { default_provider: "docker-sbx" },
    });
    expect(execution.operations).toHaveLength(1);
    expect(await readdir(join(directory, "eden"))).toEqual(["config.yaml"]);
  });
});

test("unchanged answers do not rewrite the original YAML", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const source = "{ worktree_root: '~/.saved', sandbox: { default_provider: docker-sbx } }\n";
    await writeFile(path, source);
    const execution = createExecution({ dryRun: false });
    const draft = await createFileConfigService({ pathsLowToHigh: [path], execution }).editGlobal();
    const before = await stat(path);

    const status = await draft.save(
      { worktree_root: "~/.saved", "sandbox.default_provider": "docker-sbx" },
      async () => {
        throw new Error("Unexpected conflict");
      },
    );

    expect(status).toBe("unchanged");
    expect(await Bun.file(path).text()).toBe(source);
    expect((await stat(path)).ino).toBe(before.ino);
    expect(execution.operations).toHaveLength(0);
  });
});

test("removing a default provider does not store a fake provider", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(
      path,
      "sandbox:\n  default_provider: docker-sbx\nworktree_root: ~/.worktrees\n",
    );
    const execution = createExecution({ dryRun: false });
    const service = createFileConfigService({ pathsLowToHigh: [path], execution });

    const status = await (
      await service.editGlobal()
    ).save({ "sandbox.default_provider": undefined }, async () => false);

    expect(status).toBe("saved");
    expect((await service.read()).sandbox?.default_provider).toBeUndefined();
    expect(await Bun.file(path).text()).not.toContain("none");
  });
});

test.each([false, true])(
  "external edits require explicit overwrite confirmation: %s",
  async (overwrite) => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "config.yaml");
      await writeFile(path, "agent:\n  default: claude\n");
      const execution = createExecution({ dryRun: false });
      const draft = await createFileConfigService({
        pathsLowToHigh: [path],
        execution,
      }).editGlobal();
      await writeFile(path, "agent:\n  default: codex\n");
      let confirmations = 0;

      const status = await draft.save({ worktree_root: "~/.worktrees" }, async () => {
        confirmations++;
        return overwrite;
      });
      const contents = Bun.YAML.parse(await Bun.file(path).text());

      expect(confirmations).toBe(1);
      expect(status).toBe(overwrite ? "saved" : "cancelled");
      expect(contents).toEqual(
        overwrite
          ? { agent: { default: "claude" }, worktree_root: "~/.worktrees" }
          : { agent: { default: "codex" } },
      );
      expect(execution.operations).toHaveLength(overwrite ? 1 : 0);
    });
  },
);

test("a config created while setup is open is also an overwrite conflict", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const execution = createExecution({ dryRun: false });
    const draft = await createFileConfigService({ pathsLowToHigh: [path], execution }).editGlobal();
    await writeFile(path, "agent: { default: codex }\n");
    let conflict = false;

    const status = await draft.save({ worktree_root: "~/.worktrees" }, async () => {
      conflict = true;
      return false;
    });

    expect(conflict).toBe(true);
    expect(status).toBe("cancelled");
    expect(await Bun.file(path).text()).toBe("agent: { default: codex }\n");
  });
});

test("dry-run records the write without creating directories or prompting about conflicts", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "eden", "config.yaml");
    const execution = createExecution({ dryRun: true });
    const draft = await createFileConfigService({ pathsLowToHigh: [path], execution }).editGlobal();

    const status = await draft.save({ worktree_root: "~/.worktrees" }, async () => {
      throw new Error("Unexpected conflict prompt");
    });

    expect(status).toBe("previewed");
    expect(await readdir(directory)).toEqual([]);
    expect(execution.operations).toHaveLength(1);
  });
});

testSymlinks("atomic writes preserve an existing symlink and file permissions", async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, "managed.yaml");
    const path = join(directory, "config.yaml");
    await writeFile(target, "worktree_root: ~/.old\n");
    await chmod(target, 0o640);
    await symlink(target, path);
    const execution = createExecution({ dryRun: false });
    const draft = await createFileConfigService({ pathsLowToHigh: [path], execution }).editGlobal();

    await draft.save({ worktree_root: "~/.new" }, async () => false);

    expect(await Bun.file(target).text()).toContain("~/.new");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect((await readdir(directory)).sort()).toEqual(["config.yaml", "managed.yaml"]);
  });
});

for (const absolute of [false, true]) {
  for (const dryRun of [false, true]) {
    testSymlinks.each(["set", "setup"] as const)(
      `dangling symlinks stay intact for %s with absolute=${absolute}, dryRun=${dryRun}`,
      async (method) => {
        await withTemporaryDirectory(async (directory) => {
          const path = join(directory, "config.yaml");
          const target = join(directory, "missing.yaml");
          const link = absolute ? target : "missing.yaml";
          await symlink(link, path);
          const execution = createExecution({ dryRun });
          const service = createFileConfigService({ pathsLowToHigh: [path], execution });

          const write =
            method === "set"
              ? service.set("worktree_root", "~/.new")
              : (await service.editGlobal()).save({ worktree_root: "~/.new" }, async () => {
                  throw new Error("Unexpected conflict prompt");
                });

          if (dryRun) {
            expect(await write).toBe(method === "set" ? undefined : "previewed");
          } else {
            await expect(write).rejects.toMatchObject({ code: "CONFIG_WRITE_FAILED", path });
          }
          expect((await lstat(path)).isSymbolicLink()).toBe(true);
          expect(await readlink(path)).toBe(link);
          await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await readdir(directory)).toEqual(["config.yaml"]);
          expect(execution.operations).toHaveLength(1);
        });
      },
    );
  }
}

test.each(["agent: [", "sandbox: { default_provider: unknown }", "unexpected: true", ""])(
  "invalid config fails before editing: %j",
  async (source) => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "config.yaml");
      await writeFile(path, source);
      const execution = createExecution({ dryRun: false });

      await expect(
        createFileConfigService({ pathsLowToHigh: [path], execution }).editGlobal(),
      ).rejects.toHaveProperty("code");
      expect(await Bun.file(path).text()).toBe(source);
    });
  },
);
