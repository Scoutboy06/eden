import { expect, test } from "bun:test";
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createRepository, git } from "../../worktree/tests/support/repository";
import { runCliWith } from "./support/cli";

const layers = ["global", "repository", "local"] as const;

test.each([...layers])(
  "config get and sandbox creation resolve the same %s layer from a nested directory",
  async (providerLayer) => {
    await withTemporaryDirectory(async (directory) => {
      const repository = await createRepository(directory);
      const nested = join(repository, "src", "nested");
      const xdg = join(directory, "config");
      const bin = join(directory, "bin");
      const paths = {
        global: join(xdg, "eden", "config.yaml"),
        repository: join(repository, ".eden", "config.yaml"),
        local: join(repository, ".eden", "config.local.yaml"),
      };
      const agents = { global: "claude", repository: "codex", local: "opencode" };
      await mkdir(nested, { recursive: true });
      await mkdir(bin);
      await copyFile(
        fileURLToPath(new URL("./fixtures/sbx.ts", import.meta.url)),
        join(bin, "sbx"),
      );
      await chmod(join(bin, "sbx"), 0o755);

      for (const layer of layers) {
        await mkdir(dirname(paths[layer]), { recursive: true });
        await writeFile(
          paths[layer],
          Bun.YAML.stringify({
            ...(layer === providerLayer ? { sandbox: { default_provider: "docker-sbx" } } : {}),
            ...(layers.indexOf(layer) <= layers.indexOf(providerLayer)
              ? { agent: { default: agents[layer] } }
              : {}),
          }),
        );
      }
      const options = {
        cwd: nested,
        env: {
          XDG_CONFIG_HOME: xdg,
          PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
        },
      };

      const config = await runCliWith(options, "config", "get", "--json");
      const sandbox = await runCliWith(
        options,
        "sbx",
        "create",
        "--name",
        "example",
        "--dry-run",
        "--json",
      );

      expect(config.exitCode).toBe(0);
      expect(config.stderr).toBe("");
      expect(JSON.parse(config.stdout).value).toMatchObject({
        agent: { default: agents[providerLayer] },
        sandbox: { default_provider: "docker-sbx" },
      });
      expect(sandbox.exitCode).toBe(0);
      expect(sandbox.stderr).toBe("");
      expect(JSON.parse(sandbox.stdout)).toMatchObject({
        ok: true,
        dryRun: true,
        operations: [{ type: "sandbox.create", input: { provider: "docker-sbx" } }],
      });
    });
  },
);

for (const nested of [false, true]) {
  test.each([...layers])(
    `config get and worktree creation resolve the same %s layer with nested=${nested}`,
    async (rootLayer) => {
      await withTemporaryDirectory(async (directory) => {
        const repository = await createRepository(directory);
        const cwd = nested ? join(repository, "src", "nested") : repository;
        const xdg = join(directory, "config");
        const paths = {
          global: join(xdg, "eden", "config.yaml"),
          repository: join(repository, ".eden", "config.yaml"),
          local: join(repository, ".eden", "config.local.yaml"),
        };
        const roots = {
          global: join(directory, "global-trees"),
          repository: join(directory, "repository-trees"),
          local: join(directory, "local-trees"),
        };
        await mkdir(cwd, { recursive: true });

        for (const layer of layers.slice(0, layers.indexOf(rootLayer) + 1)) {
          await mkdir(dirname(paths[layer]), { recursive: true });
          await writeFile(paths[layer], Bun.YAML.stringify({ worktree_root: roots[layer] }));
        }
        const options = { cwd, env: { XDG_CONFIG_HOME: xdg } };

        const config = await runCliWith(options, "config", "get", "worktree_root", "--json");
        const worktree = await runCliWith(
          options,
          "worktree",
          "create",
          "--name",
          "preview",
          "--dry-run",
          "--json",
        );

        expect(config.exitCode).toBe(0);
        expect(config.stderr).toBe("");
        expect(JSON.parse(config.stdout).value).toBe(roots[rootLayer]);
        expect(worktree.exitCode).toBe(0);
        expect(worktree.stderr).toBe("");
        expect(JSON.parse(worktree.stdout)).toMatchObject({
          ok: true,
          dryRun: true,
          operations: [
            {
              type: "git.worktree.create",
              input: { branch: "preview", path: join(roots[rootLayer], "repo", "preview") },
            },
          ],
        });
        await expect(lstat(roots[rootLayer])).rejects.toMatchObject({ code: "ENOENT" });
        expect(await git(repository, ["for-each-ref", "refs/heads/preview"])).toBe("");
      });
    },
  );
}

test("config set remains global while config get reads repository overrides", async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = await createRepository(directory);
    const xdg = join(directory, "config");
    const global = join(xdg, "eden", "config.yaml");
    const shared = join(repository, ".eden", "config.yaml");
    const local = join(repository, ".eden", "config.local.yaml");
    const sharedText = "agent: { default: codex }\n";
    const localText = "agent: { default: opencode }\n";
    await mkdir(dirname(global), { recursive: true });
    await mkdir(dirname(shared));
    await writeFile(global, "agent: { default: claude }\n");
    await writeFile(shared, sharedText);
    await writeFile(local, localText);
    const options = { cwd: repository, env: { XDG_CONFIG_HOME: xdg } };

    const set = await runCliWith(options, "config", "set", "agent.default", "omp");
    const get = await runCliWith(options, "config", "get", "agent.default");

    expect(set).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(get).toEqual({ exitCode: 0, stdout: "opencode\n", stderr: "" });
    expect(Bun.YAML.parse(await readFile(global, "utf8"))).toEqual({ agent: { default: "omp" } });
    expect(await readFile(shared, "utf8")).toBe(sharedText);
    expect(await readFile(local, "utf8")).toBe(localText);
  });
});
