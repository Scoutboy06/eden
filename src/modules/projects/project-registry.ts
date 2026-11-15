import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { parse as parseYaml } from "yaml";
import * as v from "valibot";

type Database = import("bun:sqlite").Database;

export type RegisteredProject = { key: string; name: string; path: string };

export type ProjectRegistryOptions = {
  databasePath?: string;
  legacyConfigPath?: string;
  stateHome?: string;
  configHome?: string;
  platform?: NodeJS.Platform;
  home?: string;
};

const currentSchemaVersion = 1;
const projectEntrySchema = v.strictObject({
  name: v.pipe(v.string(), v.nonEmpty()),
  path: v.pipe(v.string(), v.nonEmpty()),
});

export function createProjectRegistry(options: ProjectRegistryOptions = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const databasePath =
    options.databasePath ??
    join(options.stateHome ?? defaultStateHome(platform, home), "eden", "projects.sqlite");
  const legacyConfigPath =
    options.legacyConfigPath ??
    join(
      options.configHome ?? (process.env.XDG_CONFIG_HOME || join(home, ".config")),
      "eden",
      "config.yaml",
    );

  return {
    async list(): Promise<RegisteredProject[]> {
      await initialize();
      const database = await openDatabase(databasePath);
      try {
        return database
          .query<RegisteredProject, []>(
            "SELECT project_key AS key, name, path FROM projects ORDER BY project_key",
          )
          .all();
      } finally {
        database.close();
      }
    },
    async listForDryRun(): Promise<RegisteredProject[]> {
      const database = await openExistingDatabase(databasePath);
      if (!database)
        return sortProjects(await readLegacyProjects(legacyConfigPath, platform, home));
      try {
        const version = schemaVersion(database);
        if (version > currentSchemaVersion)
          throw new Error(
            `Project registry schema ${version} is newer than supported schema ${currentSchemaVersion}.`,
          );
        if (version === 0)
          return sortProjects(await readLegacyProjects(legacyConfigPath, platform, home));
        const projects = database
          .query<RegisteredProject, []>(
            "SELECT project_key AS key, name, path FROM projects ORDER BY project_key",
          )
          .all();
        const marker = database
          .query("SELECT value FROM registry_metadata WHERE key = 'legacy_import_complete'")
          .get();
        if (marker) return projects;
        const pending = await readLegacyProjects(legacyConfigPath, platform, home);
        validatePendingImport(projects, pending);
        return sortProjects([...projects, ...pending]);
      } finally {
        database.close();
      }
    },
    async register(project: RegisteredProject): Promise<void> {
      validateProject(project, platform);
      await initialize();
      const database = await openDatabase(databasePath);
      try {
        database
          .transaction(() => {
            database
              .query("INSERT INTO projects (project_key, name, path) VALUES (?, ?, ?)")
              .run(project.key, project.name, project.path);
          })
          .immediate();
      } catch (error) {
        if (isConstraintError(error)) {
          const keyExists = database
            .query("SELECT 1 AS found FROM projects WHERE project_key = ?")
            .get(project.key);
          if (keyExists) throw new Error("Project key already exists.");
          const pathExists = database
            .query("SELECT 1 AS found FROM projects WHERE path = ?")
            .get(project.path);
          if (pathExists) throw new Error("This repository is already imported.");
        }
        throw error;
      } finally {
        database.close();
      }
    },
    async registerNamed(name: string, path: string): Promise<RegisteredProject> {
      validateProject({ key: "placeholder", name, path }, platform);
      await initialize();
      const database = await openDatabase(databasePath);
      try {
        let registered!: RegisteredProject;
        database
          .transaction(() => {
            if (database.query("SELECT 1 AS found FROM projects WHERE path = ?").get(path))
              throw new Error("This repository is already imported.");
            const base = projectKeyBase(name);
            let key = base;
            for (
              let suffix = 2;
              database.query("SELECT 1 AS found FROM projects WHERE project_key = ?").get(key);
              suffix++
            )
              key = `${base}-${suffix}`;
            database
              .query("INSERT INTO projects (project_key, name, path) VALUES (?, ?, ?)")
              .run(key, name, path);
            registered = { key, name, path };
          })
          .immediate();
        return registered;
      } finally {
        database.close();
      }
    },
    async previewNamed(name: string, path: string): Promise<RegisteredProject> {
      validateProject({ key: "placeholder", name, path }, platform);
      const projects = await this.listForDryRun();
      if (projects.some((project) => project.path === path))
        throw new Error("This repository is already imported.");
      const base = projectKeyBase(name);
      const keys = new Set(projects.map(({ key }) => key));
      let key = base;
      for (let suffix = 2; keys.has(key); suffix++) key = `${base}-${suffix}`;
      return { key, name, path };
    },
    async remove(key: string): Promise<void> {
      await initialize();
      const database = await openDatabase(databasePath);
      try {
        const result = database.query("DELETE FROM projects WHERE project_key = ?").run(key);
        if (result.changes === 0) throw new Error("Project not found.");
      } finally {
        database.close();
      }
    },
  };

  async function initialize(): Promise<void> {
    await mkdir(dirname(databasePath), { recursive: true });
    const database = await openDatabase(databasePath);
    try {
      database
        .transaction(() => {
          database.exec(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL)",
          );
          const version = schemaVersion(database);
          if (version > currentSchemaVersion)
            throw new Error(
              `Project registry schema ${version} is newer than supported schema ${currentSchemaVersion}.`,
            );
          for (const migration of migrations) {
            if (migration.version <= version) continue;
            migration.apply(database);
            database
              .query("INSERT INTO schema_migrations (version) VALUES (?)")
              .run(migration.version);
          }
        })
        .immediate();
      const marker = database
        .query("SELECT value FROM registry_metadata WHERE key = 'legacy_import_complete'")
        .get();
      if (!marker) {
        const legacyProjects = await readLegacyProjects(legacyConfigPath, platform, home);
        database.transaction(() => importLegacyProjects(database, legacyProjects)).immediate();
      }
    } finally {
      database.close();
    }
  }
}

const migrations = [
  {
    version: 1,
    apply(database: Database) {
      database.exec(
        "CREATE TABLE projects (project_key TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE)",
      );
      database.exec(
        "CREATE TABLE registry_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
      );
    },
  },
] as const;

async function openDatabase(path: string): Promise<Database> {
  const { Database } = await import("bun:sqlite");
  const database = new Database(path, { create: true, readwrite: true });
  try {
    database.exec("PRAGMA busy_timeout = 10000");
    database.exec("PRAGMA journal_mode = WAL");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function listRegisteredProjects(
  options: ProjectRegistryOptions & { dryRun?: boolean } = {},
): Promise<RegisteredProject[]> {
  const registry = createProjectRegistry(options);
  return options.dryRun ? registry.listForDryRun() : registry.list();
}

export async function getRegisteredProject(
  key: string,
  options: ProjectRegistryOptions & { dryRun?: boolean } = {},
): Promise<RegisteredProject> {
  const projects = await listRegisteredProjects(options);
  const project = projects.find((entry) => entry.key === key);
  if (!project) throw new Error(`Project not found: ${key}`);
  return project;
}

async function openExistingDatabase(path: string): Promise<Database | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Project registry path is not a file: ${path}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const { Database } = await import("bun:sqlite");
  const database = new Database(path, { create: false, readonly: true });
  try {
    database.exec("PRAGMA busy_timeout = 10000");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function schemaVersion(database: Database): number {
  const table = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (!table) return 0;
  return (
    database
      .query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_migrations")
      .get()?.version ?? 0
  );
}

function importLegacyProjects(database: Database, projects: RegisteredProject[]): void {
  const marker = database
    .query("SELECT value FROM registry_metadata WHERE key = 'legacy_import_complete'")
    .get();
  if (marker) return;
  const insert = database.query("INSERT INTO projects (project_key, name, path) VALUES (?, ?, ?)");
  for (const project of projects) {
    try {
      insert.run(project.key, project.name, project.path);
    } catch (error) {
      if (isConstraintError(error))
        throw new Error(`Legacy project conflicts with an existing registry entry: ${project.key}`);
      throw error;
    }
  }
  database
    .query("INSERT INTO registry_metadata (key, value) VALUES ('legacy_import_complete', '1')")
    .run();
}

async function readLegacyProjects(
  path: string,
  platform: NodeJS.Platform,
  home: string,
): Promise<RegisteredProject[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return validateLegacyProjects(parseYaml(await file.text()), platform, home);
}

function validateLegacyProjects(
  input: unknown,
  platform: NodeJS.Platform,
  home: string,
): RegisteredProject[] {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Legacy Eden configuration must be a mapping.");
  const config = input as Record<string, unknown>;
  if (config.projects === undefined || config.projects === null) return [];
  if (typeof config.projects !== "object" || Array.isArray(config.projects))
    throw new Error("Legacy project registry must be a mapping.");
  const pathApi = platform === "win32" ? win32 : posix;
  return Object.entries(config.projects as Record<string, unknown>).map(([key, value]) => {
    const result = v.safeParse(projectEntrySchema, value);
    if (!result.success) throw new Error(`Invalid legacy project entry: ${key}`);
    const rawPath = result.output.path;
    const expanded =
      rawPath === "~"
        ? home
        : rawPath.startsWith("~/") || (platform === "win32" && rawPath.startsWith("~\\"))
          ? pathApi.join(home, rawPath.slice(2))
          : rawPath;
    const project = { key, name: result.output.name, path: pathApi.normalize(expanded) };
    const absolute =
      platform === "win32"
        ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(project.path)
        : pathApi.isAbsolute(project.path);
    if (!absolute || project.path.includes("\0"))
      throw new Error(`Invalid legacy project path: ${key}`);
    try {
      validateProject(project, platform);
    } catch {
      throw new Error(`Invalid legacy project entry: ${key}`);
    }
    return project;
  });
}

function validateProject(project: RegisteredProject, platform: NodeJS.Platform): void {
  if (
    typeof project.key !== "string" ||
    !project.key.trim() ||
    project.key === "." ||
    project.key === ".."
  )
    throw new Error("Invalid project key.");
  if (typeof project.name !== "string" || !project.name.trim())
    throw new Error("Project name must not be empty.");
  if (typeof project.path !== "string" || project.path.includes("\0"))
    throw new Error("Invalid project path.");
  const absolute =
    platform === "win32"
      ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(project.path)
      : posix.isAbsolute(project.path);
  if (!absolute) throw new Error("Project path must be absolute.");
}

function projectKeyBase(name: string): string {
  return name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^\.+$|^-+|-+$/g, "") || "project";
}

function validatePendingImport(existing: RegisteredProject[], pending: RegisteredProject[]): void {
  const keys = new Set(existing.map(({ key }) => key));
  const paths = new Set(existing.map(({ path }) => path));
  for (const project of pending) {
    if (keys.has(project.key) || paths.has(project.path))
      throw new Error(`Legacy project conflicts with an existing registry entry: ${project.key}`);
    keys.add(project.key);
    paths.add(project.path);
  }
}

function sortProjects(projects: RegisteredProject[]): RegisteredProject[] {
  return projects.sort((left, right) =>
    Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)),
  );
}

function defaultStateHome(platform: NodeJS.Platform, home: string): string {
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
  if (platform === "win32") return process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return join(home, ".local", "state");
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("constraint failed");
}
