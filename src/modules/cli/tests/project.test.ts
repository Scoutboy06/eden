import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { createTasksMiddleware } from "../../../../apps/web-ui/server/tasks";
import { createProjectRegistry } from "../../projects/project-registry";

test("project list initializes globally, sorts output, and supports JSON and human output", async () => {
  await using directory = await createTemporaryDirectory();
  const options = {
    cwd: directory.path,
    env: {
      HOME: directory.path,
      XDG_CONFIG_HOME: join(directory.path, "config"),
      XDG_STATE_HOME: join(directory.path, "state"),
    },
  };
  const config = join(directory.path, "config", "eden", "config.yaml");
  const zeta = resolve(tmpdir(), "gone/zeta");
  const alpha = resolve(tmpdir(), "gone/alpha");
  await Bun.write(
    config,
    `projects:\n  zeta:\n    name: Zeta\n    path: ${zeta}\n  alpha:\n    name: Alpha\n    path: ${alpha}\n`,
  );

  const json = await runCliWith(options, "project", "list", "--json");
  expect(json.exitCode).toBe(0);
  expect(JSON.parse(json.stdout).projects).toEqual([
    { key: "alpha", name: "Alpha", path: alpha },
    { key: "zeta", name: "Zeta", path: zeta },
  ]);
  const human = await runCliWith(options, "project", "list");
  expect(human.stdout).toContain(`alpha\tAlpha\t${alpha}`);
  expect(human.stdout.indexOf("alpha")).toBeLessThan(human.stdout.indexOf("zeta"));
});

test("project list dry-run previews legacy YAML without creating state", async () => {
  await using directory = await createTemporaryDirectory();
  const stateHome = join(directory.path, "state");
  const options = {
    cwd: directory.path,
    env: {
      HOME: directory.path,
      XDG_CONFIG_HOME: join(directory.path, "config"),
      XDG_STATE_HOME: stateHome,
    },
  };
  await Bun.write(join(directory.path, "config", "eden", "config.yaml"), "projects: {}\n");

  const result = await runCliWith(options, "project", "list", "--dry-run", "--json");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).projects).toEqual([]);
  expect(await Bun.file(stateHome).exists()).toBe(false);
});

test("project show selects exactly one registered key with compact human and JSON output", async () => {
  await using directory = await createTemporaryDirectory();
  const options = {
    cwd: directory.path,
    env: {
      HOME: directory.path,
      XDG_CONFIG_HOME: join(directory.path, "config"),
      XDG_STATE_HOME: join(directory.path, "state"),
    },
  };
  const selectedPath = join(directory.path, "missing", "my-app");
  const otherPath = join(directory.path, "other", "your-app");
  await Bun.write(
    join(directory.path, "config", "eden", "config.yaml"),
    `projects:\n  my-app:\n    name: My App\n    path: ${selectedPath}\n  your-app:\n    name: Your App\n    path: ${otherPath}\n`,
  );

  const human = await runCliWith(options, "project", "show", "my-app");
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toBe(`My App (my-app)\n  ${selectedPath}\n`);

  const json = await runCliWith(options, "project", "show", "my-app", "--json");
  expect(json.exitCode).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({
    project: { key: "my-app", name: "My App", path: selectedPath },
    ok: true,
    dryRun: false,
  });
});

test("project show reports missing keys and requires the positional key", async () => {
  await using directory = await createTemporaryDirectory();
  const options = {
    cwd: directory.path,
    env: {
      HOME: directory.path,
      XDG_CONFIG_HOME: join(directory.path, "config"),
      XDG_STATE_HOME: join(directory.path, "state"),
    },
  };

  const missing = await runCliWith(options, "project", "show");
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr).toContain("<key>");

  const unknown = await runCliWith(options, "project", "show", "unknown-key", "--json");
  expect(unknown.exitCode).not.toBe(0);
  expect(JSON.parse(unknown.stdout)).toMatchObject({
    ok: false,
    dryRun: false,
    error: { message: "Project not found: unknown-key" },
  });
});

test("project show dry-run previews legacy registration without writing state", async () => {
  await using directory = await createTemporaryDirectory();
  const stateHome = join(directory.path, "state");
  const projectPath = join(directory.path, "gone", "legacy-project");
  const config = join(directory.path, "config", "eden", "config.yaml");
  const options = {
    cwd: directory.path,
    env: {
      HOME: directory.path,
      XDG_CONFIG_HOME: join(directory.path, "config"),
      XDG_STATE_HOME: stateHome,
    },
  };
  await Bun.write(
    config,
    `projects:\n  legacy-key:\n    name: Legacy Project\n    path: ${projectPath}\n`,
  );

  const result = await runCliWith(options, "project", "show", "legacy-key", "--dry-run", "--json");

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    project: { key: "legacy-key", name: "Legacy Project", path: projectPath },
    ok: true,
    dryRun: true,
  });
  expect(await Bun.file(join(stateHome, "eden", "projects.sqlite")).exists()).toBe(false);
  expect(await Bun.file(config).text()).toContain("legacy-key");
});

test("project remove unregisters by key and preserves the repository, branch, and linked worktree", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "repository");
  const worktree = join(directory.path, "linked-worktree");
  await mkdir(repository);
  await git("init", repository);
  await git("-C", repository, "config", "core.autocrlf", "false");
  await Bun.write(join(repository, "keep.txt"), "repository contents\n");
  await git("-C", repository, "add", "keep.txt");
  await git(
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "Initial",
  );
  const baseBranch = (await gitOutput("-C", repository, "branch", "--show-current")).trim();
  await git("-C", repository, "worktree", "add", "-b", "linked-branch", worktree);
  const env = {
    HOME: directory.path,
    XDG_CONFIG_HOME: join(directory.path, "config"),
    XDG_STATE_HOME: join(directory.path, "state"),
  };
  const options = { cwd: directory.path, env };
  const added = await runCliWith(options, "project", "add", repository, "--json");
  const project = JSON.parse(added.stdout).project;
  expect(added.exitCode).toBe(0);

  const removed = await runCliWith(options, "project", "remove", project.key, "--json");
  expect(removed.exitCode).toBe(0);
  expect(JSON.parse(removed.stdout)).toEqual({
    project,
    ok: true,
    dryRun: false,
  });
  const listed = await runCliWith(options, "project", "list", "--json");
  expect(JSON.parse(listed.stdout).projects).toEqual([]);
  const shown = await runCliWith(options, "project", "show", project.key, "--json");
  expect(shown.exitCode).not.toBe(0);
  expect(JSON.parse(shown.stdout).error.message).toBe(`Project not found: ${project.key}`);
  expect(await Bun.file(join(repository, "keep.txt")).text()).toBe("repository contents\n");
  expect(await Bun.file(join(worktree, "keep.txt")).text()).toBe("repository contents\n");
  expect(await gitOutput("-C", repository, "branch", "--show-current")).toBe(`${baseBranch}\n`);
  expect(await gitOutput("-C", worktree, "branch", "--show-current")).toBe("linked-branch\n");
  expect(await gitOutput("-C", repository, "worktree", "list", "--porcelain")).toContain(
    worktree.replaceAll("\\", "/"),
  );

  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
  const middleware = createTasksMiddleware(directory.path, async () => []);
  const server = createServer(
    (request, response) =>
      void middleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`,
    );
    expect(await response.json()).toEqual({ projects: [] });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    restoreEnvironment("XDG_CONFIG_HOME", previousConfig);
    restoreEnvironment("XDG_STATE_HOME", previousState);
  }
});

test("project remove previews legacy registrations without creating state or changing YAML", async () => {
  await using directory = await createTemporaryDirectory();
  const stateHome = join(directory.path, "state");
  const config = join(directory.path, "config", "eden", "config.yaml");
  const projectPath = join(directory.path, "gone", "legacy-project");
  const hostileKey = "x'); DROP TABLE projects; --";
  const original = `projects:\n  ${JSON.stringify(hostileKey)}:\n    name: Legacy Project\n    path: ${projectPath}\n`;
  await Bun.write(config, original);
  const options = {
    cwd: directory.path,
    env: {
      HOME: directory.path,
      XDG_CONFIG_HOME: join(directory.path, "config"),
      XDG_STATE_HOME: stateHome,
    },
  };

  const result = await runCliWith(options, "project", "remove", hostileKey, "--dry-run", "--json");

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [
      {
        type: "project.remove",
        input: { key: hostileKey, name: "Legacy Project", path: projectPath },
      },
    ],
  });
  expect(JSON.parse(result.stdout).operations[0].description).toContain(hostileKey);
  expect(await Bun.file(join(stateHome, "eden", "projects.sqlite")).exists()).toBe(false);
  expect(await Bun.file(config).text()).toBe(original);

  const removed = await runCliWith(options, "project", "remove", hostileKey, "--json");
  expect(removed.exitCode).toBe(0);
  expect(JSON.parse(removed.stdout)).toEqual({
    project: { key: hostileKey, name: "Legacy Project", path: projectPath },
    ok: true,
    dryRun: false,
  });
  expect(await Bun.file(config).text()).toBe(original);

  const missing = await runCliWith(options, "project", "remove", "unknown", "--json");
  expect(missing.exitCode).not.toBe(0);
  expect(JSON.parse(missing.stdout).error.message).toBe("Project not found: unknown");
  expect(await Bun.file(config).text()).toBe(original);
  expect(await Bun.file(join(stateHome, "eden", "projects.sqlite")).exists()).toBe(true);
  const list = await runCliWith(options, "project", "list", "--json");
  expect(JSON.parse(list.stdout).projects).toEqual([]);
});

test("project remove dry-run leaves an existing database unchanged and requires a key", async () => {
  await using directory = await createTemporaryDirectory();
  const env = {
    HOME: directory.path,
    XDG_CONFIG_HOME: join(directory.path, "config"),
    XDG_STATE_HOME: join(directory.path, "state"),
  };
  const registry = createProjectRegistry({
    stateHome: env.XDG_STATE_HOME,
    configHome: env.XDG_CONFIG_HOME,
    home: env.HOME,
  });
  await registry.register({
    key: "registered",
    name: "Registered",
    path: join(directory.path, "gone"),
  });
  const databasePath = join(env.XDG_STATE_HOME, "eden", "projects.sqlite");
  const before = await Bun.file(databasePath).arrayBuffer();
  const options = { cwd: directory.path, env };

  const result = await runCliWith(
    options,
    "project",
    "remove",
    "registered",
    "--dry-run",
    "--json",
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).operations[0]).toMatchObject({
    type: "project.remove",
    input: { key: "registered", name: "Registered" },
  });
  expect(await Bun.file(databasePath).arrayBuffer()).toEqual(before);

  const missing = await runCliWith(options, "project", "remove", "--json");
  expect(missing.exitCode).not.toBe(0);
  expect(JSON.parse(missing.stdout).error.message).toBe("Positional argument 'key' is required");
});

test("project command appears in help and completion", async () => {
  await using directory = await createTemporaryDirectory();
  const options = {
    cwd: directory.path,
    env: { HOME: directory.path, XDG_STATE_HOME: join(directory.path, "state") },
  };
  const help = await runCliWith(options, "project", "--help");
  expect(help.stdout).toContain("list");
  expect(help.stdout).toContain("init");
  expect(help.stdout).toContain("show");
  expect(help.stdout).toContain("remove");
  const completion = await runCliWith(options, "completion", "bash");
  expect(completion.stdout).toContain("project");
  expect(completion.stdout).toContain("add");
  expect(completion.stdout).toContain("init");
  expect(completion.stdout).toContain("show");
  expect(completion.stdout).toContain("remove");
  const addHelp = await runCliWith(options, "project", "add", "--help");
  expect(addHelp.stdout).toContain("--name");
  expect(addHelp.stdout).toContain("<path>");
  const initHelp = await runCliWith(options, "project", "init", "--help");
  expect(initHelp.stdout).toContain("[<path>]");
  const showHelp = await runCliWith(options, "project", "show", "--help");
  expect(showHelp.stdout).toContain("<key>");
  const removeHelp = await runCliWith(options, "project", "remove", "--help");
  expect(removeHelp.stdout).toContain("<key>");
});

test("project init supports default path, human and JSON output, and dry-run", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "repository");
  const stateHome = join(directory.path, "state");
  const configHome = join(directory.path, "config");
  await mkdir(repository);
  await git("init", repository);
  const options = {
    cwd: repository,
    env: {
      HOME: directory.path,
      USERPROFILE: directory.path,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
    },
  };

  const dryRun = await runCliWith(options, "project", "init", "--dry-run", "--json");
  expect(dryRun.exitCode).toBe(0);
  expect(JSON.parse(dryRun.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [{ type: "project.init", input: { path: repository } }],
  });
  expect(await Bun.file(join(repository, ".eden")).exists()).toBe(false);
  expect(await Bun.file(join(stateHome, "eden", "projects.sqlite")).exists()).toBe(false);

  const human = await runCliWith(options, "project", "init");
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain(join(repository, ".eden", "config.yaml"));
  expect(await Bun.file(join(repository, ".eden", "config.yaml")).text()).toBe("{}\n");
  expect(await Bun.file(configHome).exists()).toBe(false);
  expect(await Bun.file(join(stateHome, "eden", "projects.sqlite")).exists()).toBe(false);

  const jsonRepository = join(directory.path, "json-repository");
  await mkdir(jsonRepository);
  await git("init", jsonRepository);
  const json = await runCliWith(
    { ...options, cwd: directory.path },
    "project",
    "init",
    jsonRepository,
    "--json",
  );
  expect(json.exitCode).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({
    project: {
      path: jsonRepository,
      configPath: join(jsonRepository, ".eden", "config.yaml"),
    },
    ok: true,
    dryRun: false,
  });

  const homeRepository = join(directory.path, "home-repository");
  await mkdir(homeRepository);
  await git("init", homeRepository);
  const homePath = await runCliWith(
    { ...options, cwd: directory.path },
    "project",
    "init",
    "~/home-repository",
    "--json",
  );
  expect(homePath.exitCode).toBe(0);
  expect(JSON.parse(homePath.stdout).project.path).toBe(homeRepository);
  expect(await Bun.file(join(stateHome, "eden", "projects.sqlite")).exists()).toBe(false);
});

test("project init returns a JSON error outside a repository", async () => {
  await using directory = await createTemporaryDirectory();
  const result = await runCliWith(
    { cwd: directory.path, env: { HOME: directory.path } },
    "project",
    "init",
    "--json",
  );

  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { message: "Path must be inside an existing Git repository." },
  });
});

test("project add accepts a cwd-relative path, returns the default name, and appears in the web picker", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "relative-repository");
  await mkdir(repository);
  await git("init", repository);
  const env = {
    HOME: directory.path,
    XDG_CONFIG_HOME: join(directory.path, "config"),
    XDG_STATE_HOME: join(directory.path, "state"),
  };
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
  const server = createServer(
    (request, response) =>
      void createTasksMiddleware(directory.path, async () => [])(request, response, () => {
        response.statusCode = 404;
        response.end();
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const added = await runCliWith(
      { cwd: directory.path, env },
      "project",
      "add",
      "relative-repository",
      "--json",
    );
    expect(added.exitCode).toBe(0);
    expect(JSON.parse(added.stdout).project).toEqual({
      key: "relative-repository",
      name: "relative-repository",
      path: repository,
    });

    const response = await fetch(`${url}/api/projects`);
    expect(await response.json()).toEqual({
      projects: [{ key: "relative-repository", name: "relative-repository" }],
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    restoreEnvironment("XDG_CONFIG_HOME", previousConfig);
    restoreEnvironment("XDG_STATE_HOME", previousState);
  }
});

test("project add supports explicit names and reports human output", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "display-name-repository");
  await mkdir(repository);
  await git("init", repository);
  const result = await runCliWith(
    {
      cwd: directory.path,
      env: {
        HOME: directory.path,
        XDG_CONFIG_HOME: join(directory.path, "config"),
        XDG_STATE_HOME: join(directory.path, "state"),
      },
    },
    "project",
    "add",
    repository,
    "--name",
    "  Display Name  ",
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`Display-Name\tDisplay Name\t${repository}`);
});

test("project add resolves key collisions through the shared registry", async () => {
  await using directory = await createTemporaryDirectory();
  const options = {
    cwd: directory.path,
    env: {
      HOME: directory.path,
      XDG_CONFIG_HOME: join(directory.path, "config"),
      XDG_STATE_HOME: join(directory.path, "state"),
    },
  };
  const projects = [];
  for (const folder of ["first-project", "second-project"]) {
    const repository = join(directory.path, folder);
    await mkdir(repository);
    await git("init", repository);
    const result = await runCliWith(
      options,
      "project",
      "add",
      repository,
      "--name",
      "Shared Name",
      "--json",
    );
    expect(result.exitCode).toBe(0);
    projects.push(JSON.parse(result.stdout).project);
  }

  expect(projects.map(({ key }) => key)).toEqual(["Shared-Name", "Shared-Name-2"]);
});

test("project add dry-run previews empty and legacy registries without writes", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "dry-run-repository");
  const configHome = join(directory.path, "config");
  const stateHome = join(directory.path, "state");
  await mkdir(repository);
  await git("init", repository);
  const result = await runCliWith(
    {
      cwd: directory.path,
      env: { HOME: directory.path, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    },
    "project",
    "add",
    repository,
    "--dry-run",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [
      {
        type: "project.add",
        input: { key: "dry-run-repository", name: "dry-run-repository", path: repository },
      },
    ],
  });
  expect(await Bun.file(join(stateHome, "eden", "projects.sqlite")).exists()).toBe(false);
  const config = join(configHome, "eden", "config.yaml");
  expect(await Bun.file(config).exists()).toBe(false);

  await Bun.write(
    config,
    `projects:\n  planned:\n    name: Planned\n    path: ${resolve(tmpdir(), "legacy-path")}\n`,
  );
  const original = await Bun.file(config).text();
  const pending = await runCliWith(
    {
      cwd: directory.path,
      env: { HOME: directory.path, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    },
    "project",
    "add",
    repository,
    "--dry-run",
    "--json",
  );
  expect(pending.exitCode).toBe(0);
  expect(await Bun.file(config).text()).toBe(original);
  expect(await Bun.file(join(stateHome, "eden", "projects.sqlite")).exists()).toBe(false);
});

test("project add dry-run leaves an existing database unchanged", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "existing-dry-run-repository");
  const env = {
    HOME: directory.path,
    XDG_CONFIG_HOME: join(directory.path, "config"),
    XDG_STATE_HOME: join(directory.path, "state"),
  };
  await mkdir(repository);
  await git("init", repository);
  const registry = createProjectRegistry({
    stateHome: env.XDG_STATE_HOME,
    configHome: env.XDG_CONFIG_HOME,
    home: env.HOME,
  });
  await registry.registerNamed("Existing", resolve(directory.path, "other"));
  const databasePath = join(env.XDG_STATE_HOME, "eden", "projects.sqlite");
  const before = await Bun.file(databasePath).arrayBuffer();
  const result = await runCliWith(
    { cwd: directory.path, env },
    "project",
    "add",
    repository,
    "--dry-run",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).operations[0].input.key).toBe("existing-dry-run-repository");
  expect(await Bun.file(databasePath).arrayBuffer()).toEqual(before);
});

test("project add rejects invalid, missing and duplicate repositories with standard errors", async () => {
  await using directory = await createTemporaryDirectory();
  const repository = join(directory.path, "duplicate-repository");
  await mkdir(repository);
  await git("init", repository);
  const options = {
    cwd: directory.path,
    env: {
      HOME: directory.path,
      XDG_CONFIG_HOME: join(directory.path, "config"),
      XDG_STATE_HOME: join(directory.path, "state"),
    },
  };
  const missing = await runCliWith(options, "project", "add", "--json");
  expect(missing.exitCode).not.toBe(0);
  const invalid = await runCliWith(
    options,
    "project",
    "add",
    join(directory.path, "missing"),
    "--json",
  );
  expect(invalid.exitCode).not.toBe(0);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, dryRun: false });
  const blankName = await runCliWith(
    options,
    "project",
    "add",
    repository,
    "--name",
    " ",
    "--json",
  );
  expect(blankName.exitCode).not.toBe(0);
  expect(JSON.parse(blankName.stdout).ok).toBe(false);
  expect((await runCliWith(options, "project", "add", repository)).exitCode).toBe(0);
  const duplicate = await runCliWith(options, "project", "add", repository, "--json");
  expect(duplicate.exitCode).not.toBe(0);
  expect(JSON.parse(duplicate.stdout).error.message).toContain("already imported");
  const humanFailure = await runCliWith(options, "project", "add", join(directory.path, "missing"));
  expect(humanFailure.exitCode).not.toBe(0);
  expect(humanFailure.stderr).toContain("does not exist");
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

async function gitOutput(...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
