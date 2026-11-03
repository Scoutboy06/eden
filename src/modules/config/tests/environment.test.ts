import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { rootPrefix } from "./support/root";

test.each(["xdg", "home"] as const)("reads the global configuration using %s", async (location) => {
  await withTemporaryDirectory(async (directory) => {
    const home = join(directory, "home");
    const xdg = join(directory, "xdg");
    const configHome = location === "xdg" ? xdg : join(home, ".config");
    await mkdir(join(configHome, "eden"), { recursive: true });
    await writeFile(join(configHome, "eden", "config.yaml"), "agent:\n  default: opencode\n");
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("./fixtures/read.ts", import.meta.url))],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: location === "xdg" ? xdg : "",
        },
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
    expect(JSON.parse(stdout)).toEqual({
      worktree_root: join(home, ".worktrees"),
      agent: { default: "opencode" },
    });
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
