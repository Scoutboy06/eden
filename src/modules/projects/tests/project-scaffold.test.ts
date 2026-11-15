import { expect, test } from "bun:test";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createExecution } from "../../execution";
import { createFileConfigService } from "../../config/config.service";
import { createProjectScaffoldService } from "../project-scaffold";

test("project init defaults to the containing repository root and leaves global settings inherited", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "repository");
  const nested = join(repository, "nested", "directory");
  const configHome = join(directory.path, "config");
  const globalConfig = join(configHome, "eden", "config.yaml");
  const localConfig = join(repository, ".eden", "config.yaml");
  const localOnlyConfig = join(repository, ".eden", "config.local.yaml");
  await mkdir(nested, { recursive: true });
  await git("init", repository);
  await Bun.write(globalConfig, "agent:\n  default: claude\n");
  await mkdir(join(repository, ".eden"));
  await Bun.write(localOnlyConfig, "sandbox:\n  default_provider: docker-sbx\n");

  const service = createProjectScaffoldService(createExecution({ dryRun: false }));
  const result = await service.init(undefined, { cwd: nested });
  expect(result).toEqual({ path: repository, configPath: localConfig });
  expect(await Bun.file(localConfig).text()).toBe("{}\n");
  expect(Bun.YAML.parse(await Bun.file(localConfig).text())).toEqual({});
  const resolved = await createFileConfigService({
    pathsLowToHigh: [globalConfig, localConfig, localOnlyConfig],
  }).read();
  expect(resolved.agent).toEqual({ default: "claude" });
  expect(resolved.sandbox?.default_provider).toBe("docker-sbx");
  expect(await Bun.file(localOnlyConfig).text()).toBe("sandbox:\n  default_provider: docker-sbx\n");
  expect(await Bun.file(globalConfig).text()).toBe("agent:\n  default: claude\n");
});

test("project init accepts relative and absolute repository paths", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "repository");
  await mkdir(repository);
  await git("init", repository);

  const relative = createProjectScaffoldService(createExecution({ dryRun: false }));
  const first = await relative.init("repository", { cwd: directory.path });
  expect(first.path).toBe(repository);
  await rm(join(repository, ".eden"), { recursive: true, force: true });

  const absolute = createProjectScaffoldService(createExecution({ dryRun: false }));
  const second = await absolute.init(repository, { cwd: directory.path });
  expect(second.configPath).toBe(join(repository, ".eden", "config.yaml"));
});

test("project init scaffolds a linked worktree root rather than its main checkout", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "repository");
  const worktree = join(directory.path, "linked-worktree");
  await mkdir(repository);
  await git("init", repository);
  await git(
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "Initial",
  );
  await git("-C", repository, "worktree", "add", "-b", "linked-branch", worktree);

  const service = createProjectScaffoldService(createExecution({ dryRun: false }));
  const result = await service.init(worktree);

  expect(result.path).toBe(worktree);
  expect((await lstat(join(worktree, ".git"))).isFile()).toBe(true);
  expect(await Bun.file(join(worktree, ".eden", "config.yaml")).text()).toBe("{}\n");
  expect(await Bun.file(join(repository, ".eden", "config.yaml")).exists()).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "project init refuses existing config files and symlinks without changing them",
  async () => {
    await using directory = await createTemporaryDirectory();
    const repository = join(directory.path, "repository");
    await mkdir(join(repository, ".eden"), { recursive: true });
    await git("init", repository);
    const configPath = join(repository, ".eden", "config.yaml");
    const service = createProjectScaffoldService(createExecution({ dryRun: false }));
    await Bun.write(configPath, "keep: me\n");
    await expect(service.init(repository)).rejects.toThrow("already exists");
    expect(await Bun.file(configPath).text()).toBe("keep: me\n");

    await rm(configPath);
    const target = join(directory.path, "target.yaml");
    await Bun.write(target, "outside: unchanged\n");
    await symlink(target, configPath);
    await expect(service.init(repository)).rejects.toThrow("already exists");
    expect(await readlink(configPath)).toBe(target);
    expect(await Bun.file(target).text()).toBe("outside: unchanged\n");

    await rm(configPath);
    await symlink(join(directory.path, "absent.yaml"), configPath);
    await expect(service.init(repository)).rejects.toThrow("already exists");
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
  },
);

test("project init refuses .eden symlinks and non-directory destinations", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "repository");
  const outside = join(directory.path, "outside");
  await mkdir(repository);
  await mkdir(outside);
  await git("init", repository);
  const service = createProjectScaffoldService(createExecution({ dryRun: false }));
  await symlink(
    outside,
    join(repository, ".eden"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(service.init(repository)).rejects.toThrow("must not be a symlink");
  expect(await Bun.file(join(outside, "config.yaml")).exists()).toBe(false);

  await rm(join(repository, ".eden"));
  await Bun.write(join(repository, ".eden"), "blocked");
  await expect(service.init(repository)).rejects.toThrow("must be a directory");
  expect(await Bun.file(join(repository, ".eden")).text()).toBe("blocked");
});

test("project init dry-run plans creation without writing project or registry state", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "repository");
  const stateHome = join(directory.path, "state");
  const configHome = join(directory.path, "config");
  await mkdir(repository);
  await git("init", repository);
  const execution = createExecution({ dryRun: true });
  const service = createProjectScaffoldService(execution);

  const result = await service.init(repository);

  expect(result.configPath).toBe(join(repository, ".eden", "config.yaml"));
  expect(execution.operations).toEqual([
    {
      type: "project.init",
      description: `Create project config ${result.configPath}`,
      input: { path: repository, configPath: result.configPath },
    },
  ]);
  expect(await Bun.file(join(repository, ".eden")).exists()).toBe(false);
  expect(await Bun.file(join(stateHome, "eden", "projects.sqlite")).exists()).toBe(false);
  expect(await Bun.file(join(configHome, "eden", "config.yaml")).exists()).toBe(false);
});

test("concurrent project init attempts create one config without overwriting it", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "repository");
  await mkdir(repository);
  await git("init", repository);
  const init = () =>
    createProjectScaffoldService(createExecution({ dryRun: false })).init(repository);

  const results = await Promise.allSettled([init(), init()]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(await Bun.file(join(repository, ".eden", "config.yaml")).text()).toBe("{}\n");
});

test("project init reports invalid path, missing directory, and non-repository errors", async () => {
  await using directory = await createTemporaryDirectory();
  const service = createProjectScaffoldService(createExecution({ dryRun: false }));

  await expect(service.init(undefined, { cwd: join(directory.path, "missing") })).rejects.toThrow(
    "does not exist",
  );
  await expect(service.init(join(directory.path, "absent"))).rejects.toThrow("does not exist");
  await expect(service.init(directory.path)).rejects.toThrow("Git repository");
  await expect(service.init(`bad\0path`)).rejects.toThrow("null bytes");
});

async function git(...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    stdout: "ignore",
    stderr: "pipe",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
  const error = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(error);
}
