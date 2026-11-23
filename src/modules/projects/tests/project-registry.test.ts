import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createProjectRegistry, listRegisteredProjects } from "../project-registry";

test("imports legacy global projects once, preserving keys, normalized paths, and YAML", async () => {
  await using directory = await createTemporaryDirectory();
  const config = join(directory.path, "config", "eden", "config.yaml");
  const databasePath = join(directory.path, "state", "eden.sqlite");
  const home = join(directory.path, "home");
  await mkdir(join(directory.path, "config", "eden"), { recursive: true });
  const original =
    'agent:\n  default: codex\nprojects:\n  "Eden & Co":\n    name: Legacy Eden\n    path: ~/src/eden/../missing\n';
  await writeFile(config, original);
  const registry = createProjectRegistry({
    databasePath,
    legacyConfigPath: config,
    home,
  });

  expect(await registry.list()).toEqual([
    { key: "Eden & Co", name: "Legacy Eden", path: join(home, "src", "missing") },
  ]);
  await registry.remove("Eden & Co");
  await writeFile(config, `${original}  ignored: true\n`);
  expect(await registry.list()).toEqual([]);
  expect(await Bun.file(config).text()).toContain("agent:");
});

test("reopens and lists missing-directory registrations in key order", async () => {
  await using directory = await createTemporaryDirectory();
  const registryOptions = {
    databasePath: join(directory.path, "registry.sqlite"),
    legacyConfigPath: join(directory.path, "absent.yaml"),
  };
  const missing = resolve(tmpdir(), "gone/missing");
  const other = resolve(tmpdir(), "gone/other");
  const first = createProjectRegistry(registryOptions);
  await first.register({ key: "zeta", name: "Missing", path: missing });
  await first.register({ key: "alpha", name: "Other", path: other });

  expect(await createProjectRegistry(registryOptions).list()).toEqual([
    { key: "alpha", name: "Other", path: other },
    { key: "zeta", name: "Missing", path: missing },
  ]);
});

test("rejects invalid legacy data without partially importing it", async () => {
  await using directory = await createTemporaryDirectory();
  const config = join(directory.path, "config.yaml");
  const databasePath = join(directory.path, "registry.sqlite");
  await writeFile(
    config,
    `projects:\n  first:\n    name: First\n    path: ${JSON.stringify(resolve(tmpdir(), "first"))}\n  second:\n    name: Second\n    path: relative\n`,
  );
  const registry = createProjectRegistry({ databasePath, legacyConfigPath: config });

  await expect(registry.list()).rejects.toThrow("Invalid legacy project path: second");
  const database = new Database(databasePath);
  expect(database.query("SELECT project_key FROM projects").all()).toEqual([]);
  expect(
    database
      .query("SELECT value FROM registry_metadata WHERE key = 'legacy_import_complete'")
      .get(),
  ).toBeNull();
  database.close();
});

test("applies migrations once and rolls back a failed migration version update", async () => {
  await using directory = await createTemporaryDirectory();
  const databasePath = join(directory.path, "registry.sqlite");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL)");
  database.exec("INSERT INTO schema_migrations VALUES (0)");
  database.exec("CREATE TABLE projects (broken TEXT)");
  database.close();
  const registry = createProjectRegistry({
    databasePath,
    legacyConfigPath: join(directory.path, "absent.yaml"),
  });

  await expect(registry.list()).rejects.toThrow();
  const reopened = new Database(databasePath);
  expect(reopened.query("SELECT version FROM schema_migrations").all()).toEqual([{ version: 0 }]);
  expect(
    reopened.query("SELECT name FROM sqlite_master WHERE name = 'registry_metadata'").all(),
  ).toEqual([]);
  reopened.close();
});

test("rejects databases from a newer schema without changing them", async () => {
  await using directory = await createTemporaryDirectory();
  const databasePath = join(directory.path, "registry.sqlite");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL)");
  database.exec("INSERT INTO schema_migrations VALUES (99)");
  database.close();
  const registry = createProjectRegistry({
    databasePath,
    legacyConfigPath: join(directory.path, "absent.yaml"),
  });

  await expect(registry.list()).rejects.toThrow("newer than supported");
  await expect(
    listRegisteredProjects({
      databasePath,
      legacyConfigPath: join(directory.path, "absent.yaml"),
      dryRun: true,
    }),
  ).rejects.toThrow("newer than supported");
});

test("serializes concurrent registrations and binds hostile values as data", async () => {
  await using directory = await createTemporaryDirectory();
  const registry = createProjectRegistry({
    databasePath: join(directory.path, "registry.sqlite"),
    legacyConfigPath: join(directory.path, "absent.yaml"),
  });
  const hostileKey = "x'); DROP TABLE projects; --";
  const hostilePath = resolve(tmpdir(), "hostile");
  const samePath = resolve(tmpdir(), "same");
  await Promise.all([
    registry.register({ key: hostileKey, name: "hostile", path: hostilePath }),
    registry.register({ key: "same", name: "same", path: samePath }),
  ]);
  await expect(
    Promise.all([
      registry.register({ key: "same-name", name: "One", path: resolve(tmpdir(), "same-path") }),
      registry.register({ key: "same-name", name: "Two", path: resolve(tmpdir(), "other-path") }),
    ]),
  ).rejects.toThrow("Project key already exists.");

  expect((await registry.list()).map(({ key }) => key)).toContain(hostileKey);
  expect((await registry.list()).map(({ key }) => key)).toContain("same");
});

test("assigns collision-safe keys and rejects duplicate paths across concurrent web registrations", async () => {
  await using directory = await createTemporaryDirectory();
  const registry = createProjectRegistry({
    databasePath: join(directory.path, "registry.sqlite"),
    legacyConfigPath: join(directory.path, "absent.yaml"),
  });
  const first = resolve(tmpdir(), "first");
  const second = resolve(tmpdir(), "second");
  const same = resolve(tmpdir(), "same");
  const projects = await Promise.all([
    registry.registerNamed("Shared Name", first),
    registry.registerNamed("Shared Name", second),
  ]);
  expect(projects.map(({ key }) => key).sort()).toEqual(["Shared-Name", "Shared-Name-2"]);

  const duplicatePath = await Promise.allSettled([
    registry.registerNamed("Duplicate", same),
    registry.registerNamed("Duplicate", same),
  ]);
  expect(duplicatePath.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(duplicatePath.filter(({ status }) => status === "rejected")).toHaveLength(1);
  await expect(registry.listForDryRun()).resolves.toHaveLength(3);
});

test("dry-run list previews legacy data without creating state", async () => {
  await using directory = await createTemporaryDirectory();
  const databasePath = join(directory.path, "state", "registry.sqlite");
  const config = join(directory.path, "config.yaml");
  const preview = resolve(tmpdir(), "preview");
  await writeFile(config, `projects:\n  preview:\n    name: Preview\n    path: ${preview}\n`);

  expect(
    await listRegisteredProjects({ databasePath, legacyConfigPath: config, dryRun: true }),
  ).toEqual([{ key: "preview", name: "Preview", path: preview }]);
  expect(await Bun.file(databasePath).exists()).toBe(false);
});

test("dry-run sorts legacy entries consistently and rejects root-relative Windows paths", async () => {
  await using directory = await createTemporaryDirectory();
  const config = join(directory.path, "config.yaml");
  const databasePath = join(directory.path, "absent", "registry.sqlite");
  await writeFile(
    config,
    `projects:\n  zeta:\n    name: Zeta\n    path: ${JSON.stringify("C:\\work\\zeta")}\n  alpha:\n    name: Alpha\n    path: ${JSON.stringify("\\root-relative")}\n`,
  );
  const options = {
    databasePath,
    legacyConfigPath: config,
    platform: "win32" as const,
    home: "C:\\Users\\Tester",
  };

  await expect(listRegisteredProjects({ ...options, dryRun: true })).rejects.toThrow(
    "Invalid legacy project path: alpha",
  );
  await writeFile(
    config,
    `projects:\n  zeta:\n    name: Zeta\n    path: ${JSON.stringify("C:\\work\\zeta")}\n  alpha:\n    name: Alpha\n    path: ${JSON.stringify("\\\\server\\share\\alpha")}\n`,
  );
  expect(await listRegisteredProjects({ ...options, dryRun: true })).toEqual([
    { key: "alpha", name: "Alpha", path: "\\\\server\\share\\alpha" },
    { key: "zeta", name: "Zeta", path: "C:\\work\\zeta" },
  ]);
  expect(await Bun.file(databasePath).exists()).toBe(false);
});

test("dry-run previews and validates an incomplete legacy import without writes", async () => {
  await using directory = await createTemporaryDirectory();
  const databasePath = join(directory.path, "registry.sqlite");
  const config = join(directory.path, "config.yaml");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL)");
  database.exec("INSERT INTO schema_migrations VALUES (1)");
  database.exec(
    "CREATE TABLE projects (project_key TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE)",
  );
  database.exec(
    "CREATE TABLE registry_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
  );
  database
    .query("INSERT INTO projects VALUES (?, ?, ?)")
    .run("partial", "Partial", resolve(tmpdir(), "partial"));
  database.close();
  await writeFile(
    config,
    `projects:\n  zeta:\n    name: Zeta\n    path: ${resolve(tmpdir(), "zeta")}\n  alpha:\n    name: Alpha\n    path: ${resolve(tmpdir(), "alpha")}\n`,
  );
  const registry = createProjectRegistry({ databasePath, legacyConfigPath: config });

  expect(await registry.listForDryRun()).toEqual([
    { key: "alpha", name: "Alpha", path: resolve(tmpdir(), "alpha") },
    { key: "partial", name: "Partial", path: resolve(tmpdir(), "partial") },
    { key: "zeta", name: "Zeta", path: resolve(tmpdir(), "zeta") },
  ]);
  await writeFile(
    config,
    `projects:\n  partial:\n    name: Conflict\n    path: ${resolve(tmpdir(), "conflict")}\n`,
  );
  await expect(registry.listForDryRun()).rejects.toThrow(
    "conflicts with an existing registry entry: partial",
  );
  await writeFile(config, "projects:\n  invalid:\n    name: Invalid\n    path: relative\n");
  await expect(registry.listForDryRun()).rejects.toThrow("Invalid legacy project path: invalid");
  const reopened = new Database(databasePath, { readonly: true });
  expect(reopened.query("SELECT project_key FROM projects ORDER BY project_key").all()).toEqual([
    { project_key: "partial" },
  ]);
  expect(reopened.query("SELECT * FROM registry_metadata").all()).toEqual([]);
  reopened.close();
});

test("completed legacy import marker prevents removed projects from returning in dry-run", async () => {
  await using directory = await createTemporaryDirectory();
  const config = join(directory.path, "config.yaml");
  const registry = createProjectRegistry({
    databasePath: join(directory.path, "registry.sqlite"),
    legacyConfigPath: config,
  });
  await writeFile(
    config,
    `projects:\n  old:\n    name: Old\n    path: ${resolve(tmpdir(), "old")}\n`,
  );
  await registry.list();
  await registry.remove("old");

  expect(await registry.listForDryRun()).toEqual([]);
});

test("register APIs reject malformed values before creating registry state", async () => {
  await using directory = await createTemporaryDirectory();
  const databasePath = join(directory.path, "registry.sqlite");
  const registry = createProjectRegistry({
    databasePath,
    legacyConfigPath: join(directory.path, "absent.yaml"),
  });

  await expect(
    registry.register({ key: "", name: "Name", path: resolve(tmpdir(), "repo") }),
  ).rejects.toThrow("Invalid project key");
  await expect(registry.registerNamed("  ", resolve(tmpdir(), "repo"))).rejects.toThrow(
    "name must not be empty",
  );
  await expect(registry.registerNamed("Name", "relative")).rejects.toThrow("path must be absolute");
  expect(await Bun.file(databasePath).exists()).toBe(false);
});

test("dry-run rejects a registry path that exists but is not a database file", async () => {
  await using directory = await createTemporaryDirectory();
  const registry = createProjectRegistry({
    databasePath: directory.path,
    legacyConfigPath: join(directory.path, "absent.yaml"),
  });

  await expect(registry.listForDryRun()).rejects.toThrow("Project registry path is not a file");
});

test("dry-run reads an existing database without importing changed legacy YAML", async () => {
  await using directory = await createTemporaryDirectory();
  const databasePath = join(directory.path, "registry.sqlite");
  const config = join(directory.path, "config.yaml");
  const registry = createProjectRegistry({ databasePath, legacyConfigPath: config });
  const saved = resolve(tmpdir(), "saved");
  await registry.register({ key: "saved", name: "Saved", path: saved });
  await writeFile(
    config,
    `projects:\n  later:\n    name: Later\n    path: ${resolve(tmpdir(), "later")}\n`,
  );

  expect(await registry.listForDryRun()).toEqual([{ key: "saved", name: "Saved", path: saved }]);
  const database = new Database(databasePath);
  expect(database.query("SELECT project_key FROM projects ORDER BY project_key").all()).toEqual([
    { project_key: "saved" },
  ]);
  database.close();
});
