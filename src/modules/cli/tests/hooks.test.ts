import { expect, test } from "bun:test";
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createRepository, git } from "../../worktree/tests/support/repository";
import { runCliWith, withRunningCli } from "./support/cli";

async function fixture(directory: string) {
  const repo = await createRepository(directory);
  const config = join(directory, "config");
  const hooks = join(config, "eden", "hooks");
  await mkdir(hooks, { recursive: true });
  for (const phase of ["pre", "post"]) {
    const path = join(hooks, `worktree.create.${phase}`);
    await copyFile(new URL("./fixtures/hook.ts", import.meta.url), path);
    await chmod(path, 0o755);
  }

  return {
    repo,
    hooks,
    cwd: repo,
    env: { HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: config },
  };
}

test("hooks receive request and context, apply literal overwrites, and run post in the relative destination", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    const overwrites = { branch: "custom", path: "../custom-tree", base: "main" };
    const response = await runCliWith(
      {
        ...options,
        env: {
          ...options.env,
          EDEN_TEST_PRE_OUTPUT: JSON.stringify({ overwrites }),
        },
      },
      "worktree",
      "create",
      "--name",
      "Friendly Name",
      "--json",
    );
    const data = JSON.parse(response.stdout);

    expect(response.exitCode).toBe(0);
    expect(response.stderr).toBe("");
    expect(data).toMatchObject({ ok: true, result: overwrites });
    expect(data.hooks[0]).toMatchObject({
      ok: true,
      input: {
        request: { name: "Friendly Name" },
        context: { cwd: options.repo, repositoryName: "repo" },
        proposed: { branch: "friendly-name" },
      },
      output: { overwrites },
      stderr: "pre diagnostic\n",
    });
    expect(JSON.parse(data.hooks[1].stdout)).toMatchObject({
      cwd: join(directory, "custom-tree"),
      input: { result: overwrites, context: { cwd: options.repo } },
    });
    expect(await git(join(directory, "custom-tree"), ["branch", "--show-current"])).toBe("custom");
  });
});

test("a branch-only overwrite does not recalculate the destination", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    const response = await runCliWith(
      {
        ...options,
        env: {
          ...options.env,
          EDEN_TEST_PRE_OUTPUT: '{"overwrites":{"branch":"changed"}}',
        },
      },
      "worktree",
      "create",
      "--name",
      "original",
      "--json",
    );

    expect(JSON.parse(response.stdout).result).toMatchObject({
      branch: "changed",
      path: join(directory, ".worktrees", "repo", "original"),
    });
  });
});

test.each(["", " \n\t", "{}"])("pre stdout %j means no overwrites", async (stdout) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    const response = await runCliWith(
      {
        ...options,
        env: {
          ...options.env,
          EDEN_TEST_PRE_OUTPUT: stdout,
        },
      },
      "worktree",
      "create",
      "--name",
      "plain",
      "--json",
    );

    expect(response.exitCode).toBe(0);
    expect(JSON.parse(response.stdout).hooks[0].output).toEqual({});
  });
});

test.each([
  '{"unknown":true}',
  '{"overwrites":{"unknown":"x"}}',
  '{"overwrites":{"branch":1}}',
  "not json",
])("invalid pre response %s stops creation and preserves raw output", async (stdout) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    const response = await runCliWith(
      {
        ...options,
        env: {
          ...options.env,
          EDEN_TEST_PRE_OUTPUT: stdout,
        },
      },
      "worktree",
      "create",
      "--name",
      "rejected",
      "--json",
    );
    const data = JSON.parse(response.stdout);

    expect(response.exitCode).toBe(1);
    expect(response.stderr).toBe("");
    expect(data).toMatchObject({
      ok: false,
      hooks: [{ ok: false, stdout, stderr: "pre diagnostic\n" }],
    });
    expect(data.hooks).toHaveLength(1);
    expect(await git(options.repo, ["for-each-ref", "refs/heads/rejected"])).toBe("");
  });
});

test("post failure retains the created worktree and both hook records", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    const response = await runCliWith(
      {
        ...options,
        env: {
          ...options.env,
          EDEN_TEST_POST_EXIT: "7",
        },
      },
      "worktree",
      "create",
      "--name",
      "retained",
      "--json",
    );
    const data = JSON.parse(response.stdout);

    expect(response.exitCode).toBe(1);
    expect(response.stderr).toBe("");
    expect(data.ok).toBe(false);
    expect(data.hooks).toHaveLength(2);
    expect(data.hooks[1]).toMatchObject({ ok: false, error: { exitCode: 7 } });
    expect(await git(data.hooks[1].input.result.path, ["branch", "--show-current"])).toBe(
      "retained",
    );
  });
});

test("nonzero pre exit prevents creation even with valid JSON", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    const response = await runCliWith(
      { ...options, env: { ...options.env, EDEN_TEST_PRE_EXIT: "3" } },
      "worktree",
      "create",
      "--name",
      "blocked",
      "--json",
    );
    const data = JSON.parse(response.stdout);

    expect(response.exitCode).toBe(1);
    expect(data.hooks).toHaveLength(1);
    expect(data.hooks[0]).toMatchObject({ ok: false, stdout: "{}", error: { exitCode: 3 } });
    expect(await git(options.repo, ["for-each-ref", "refs/heads/blocked"])).toBe("");
  });
});

test("Git reports invalid override values after a successful pre hook", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    const response = await runCliWith(
      {
        ...options,
        env: {
          ...options.env,
          EDEN_TEST_PRE_OUTPUT: '{"overwrites":{"branch":"bad..ref"}}',
        },
      },
      "worktree",
      "create",
      "--name",
      "valid",
      "--json",
    );
    const data = JSON.parse(response.stdout);

    expect(response.exitCode).toBe(1);
    expect(data.hooks).toHaveLength(1);
    expect(data.hooks[0].ok).toBe(true);
    expect(data.error.message).toContain("fatal:");
    expect(data.error.message).toContain("bad..ref");
  });
});

test.each(["", "dependency install complete\n"])(
  "post stdout accepts arbitrary text %j",
  async (stdout) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await fixture(directory);
      const response = await runCliWith(
        { ...options, env: { ...options.env, EDEN_TEST_POST_OUTPUT: stdout } },
        "worktree",
        "create",
        "--name",
        "post-output",
        "--json",
      );

      expect(response.exitCode).toBe(0);
      expect(JSON.parse(response.stdout).hooks[1]).toMatchObject({ ok: true, stdout });
    });
  },
);

test("a non-executable hook fails rather than being skipped", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    await chmod(join(options.hooks, "worktree.create.pre"), 0o644);
    const response = await runCliWith(
      options,
      "worktree",
      "create",
      "--name",
      "permission",
      "--json",
    );

    expect(response.exitCode).toBe(1);
    expect(JSON.parse(response.stdout).hooks[0]).toMatchObject({
      ok: false,
      error: { code: "HOOK_FAILED" },
    });
    expect(await git(options.repo, ["for-each-ref", "refs/heads/permission"])).toBe("");
  });
});

test("dry-run discovers hooks without executing either script or creating directories", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    const response = await runCliWith(
      {
        ...options,
        env: {
          ...options.env,
          EDEN_TEST_PRE_EXIT: "42",
        },
      },
      "worktree",
      "create",
      "--name",
      "preview",
      "--dry-run",
      "--json",
    );
    const data = JSON.parse(response.stdout);

    expect(response.exitCode).toBe(0);
    expect(response.stderr).toBe("");
    expect(data).toMatchObject({ ok: true, dryRun: true });
    expect(data.operations.map((op: { type: string }) => op.type)).toEqual([
      "hook.run",
      "git.worktree.create",
      "hook.run",
    ]);
    expect(data.operations[0].description).toContain("overwrites unknown");
    await expect(lstat(join(directory, ".worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("human mode streams diagnostics and keeps post stdout captured", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    const response = await runCliWith(options, "worktree", "create", "--name", "human");

    expect(response.exitCode).toBe(0);
    expect(response.stderr).toBe("pre diagnostic\npost diagnostic\n");
    expect(response.stdout).toStartWith("Created human at ");
    expect(response.stdout).not.toContain("context");
  });
});

test("Ctrl+C stops the hook process group and emits a single cancellation response", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await fixture(directory);
    const path = join(options.hooks, "worktree.create.pre");
    await copyFile(new URL("./fixtures/wait-hook.ts", import.meta.url), path);
    await chmod(path, 0o755);
    const ready = join(directory, "ready");
    await withRunningCli(
      { ...options, env: { ...options.env, EDEN_TEST_READY: ready } },
      ["worktree", "create", "--name", "cancelled", "--json"],
      async (cli) => {
        await cli.waitForReady(ready);
        cli.interrupt();
        const response = await cli.result;

        expect(response.exitCode).toBe(130);
        const data = JSON.parse(response.stdout);
        expect(response.stderr).toBe("");
        expect(data).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
        expect(data.hooks[0].stderr).toContain("cleanup");
        const pids = /ready:(\d+):(\d+)/.exec(data.hooks[0].stderr)!;
        expect(pids).not.toBeNull();
        for (const pid of pids.slice(1)) expect(() => process.kill(Number(pid), 0)).toThrow();
      },
    );
  });
});
