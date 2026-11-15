import { expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import {
  createProjectRegistrationService,
  prepareProjectRegistration,
} from "../project-registration";
import { createExecution } from "../../execution";
import { createProjectRegistry } from "../project-registry";

test("shared registration canonicalizes roots, symlinks and linked worktrees", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "repository");
  const alias = join(directory.path, "alias");
  await mkdir(repository, { recursive: true });
  await git("init", repository);
  await symlink(repository, alias, process.platform === "win32" ? "junction" : "dir");

  const originalState = process.env.XDG_STATE_HOME;
  const originalConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = join(directory.path, "state");
  process.env.XDG_CONFIG_HOME = join(directory.path, "config");
  try {
    const service = createProjectRegistrationService(createExecution({ dryRun: false }));
    await service.add({ path: repository });
    await expect(prepareProjectRegistration({ path: alias })).rejects.toThrow("already imported");
    await expect(prepareProjectRegistration({ path: repository })).rejects.toThrow(
      "already imported",
    );

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
    const worktree = join(directory.path, "worktree");
    await git("-C", repository, "worktree", "add", "-b", "linked", worktree);
    await expect(prepareProjectRegistration({ path: worktree })).rejects.toThrow(
      "already imported",
    );
  } finally {
    restoreEnvironment("XDG_STATE_HOME", originalState);
    restoreEnvironment("XDG_CONFIG_HOME", originalConfig);
  }
});

test("shared registration validates names and defaults the name from the canonical repository", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "default-name");
  await mkdir(repository, { recursive: true });
  await git("init", repository);
  const originalState = process.env.XDG_STATE_HOME;
  const originalConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = join(directory.path, "state");
  process.env.XDG_CONFIG_HOME = join(directory.path, "config");
  try {
    const registration = await prepareProjectRegistration({ path: repository });
    expect(registration).toEqual({ name: "default-name", path: repository });
    await expect(prepareProjectRegistration({ path: repository, name: " " })).rejects.toThrow(
      "project name",
    );
    await expect(
      prepareProjectRegistration({ path: repository, name: "x".repeat(121) }),
    ).rejects.toThrow("120 characters");
    await expect(prepareProjectRegistration({ path: "relative" })).rejects.toThrow("absolute");
    await expect(
      prepareProjectRegistration({ path: join(directory.path, "missing") }),
    ).rejects.toThrow("does not exist");
  } finally {
    restoreEnvironment("XDG_STATE_HOME", originalState);
    restoreEnvironment("XDG_CONFIG_HOME", originalConfig);
  }
});

test("dry-run registration previews the key without initializing or writing registry state", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "dry-run-repository");
  const stateHome = join(directory.path, "state");
  const configHome = join(directory.path, "config");
  await mkdir(repository, { recursive: true });
  await git("init", repository);
  const originalState = process.env.XDG_STATE_HOME;
  const originalConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    const execution = createExecution({ dryRun: true });
    const service = createProjectRegistrationService(execution);
    const project = await service.add({ path: repository, name: "Planned Name" });
    expect(project).toEqual({ key: "Planned-Name", name: "Planned Name", path: repository });
    expect(execution.operations[0]).toMatchObject({
      type: "project.add",
      input: { key: "Planned-Name", name: "Planned Name", path: repository },
    });
    expect(await Bun.file(join(stateHome, "eden", "projects.sqlite")).exists()).toBe(false);
    expect(await Bun.file(join(configHome, "eden", "config.yaml")).exists()).toBe(false);
  } finally {
    restoreEnvironment("XDG_STATE_HOME", originalState);
    restoreEnvironment("XDG_CONFIG_HOME", originalConfig);
  }
});

test("dry-run registration previews an existing registry without changing it", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "existing-repository");
  const databasePath = join(directory.path, "state", "eden", "projects.sqlite");
  await mkdir(repository, { recursive: true });
  await git("init", repository);
  const originalState = process.env.XDG_STATE_HOME;
  const originalConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = join(directory.path, "state");
  process.env.XDG_CONFIG_HOME = join(directory.path, "config");
  try {
    const registry = createProjectRegistry({
      databasePath,
      legacyConfigPath: join(directory.path, "absent.yaml"),
    });
    await registry.registerNamed("Taken", join(directory.path, "somewhere"));
    const before = await Bun.file(databasePath).arrayBuffer();
    const service = createProjectRegistrationService(createExecution({ dryRun: true }));
    const result = await service.add({ path: repository, name: "Taken" });
    expect(result.key).toBe("Taken-2");
    expect(await Bun.file(databasePath).arrayBuffer()).toEqual(before);
  } finally {
    restoreEnvironment("XDG_STATE_HOME", originalState);
    restoreEnvironment("XDG_CONFIG_HOME", originalConfig);
  }
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
