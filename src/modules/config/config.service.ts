import { homedir } from "node:os";
import { join } from "node:path";
import { Document, parseDocument } from "yaml";
import type { Execution } from "../execution";
import { ConfigYamlEditor } from "./edit";
import {
  readConfigFile,
  readValidatedConfig,
  parseConfigYaml,
  validateConfig,
  writeConfigFile,
} from "./file";
import { mergeConfigLayer, omitHosts } from "./layers";
import type { Config } from "./schema";
import { configLeafPath } from "./select";

export interface ConfigReader {
  read(): Promise<Config>;
}

export interface ResolvedConfigReader extends ConfigReader {
  readWithProvenance(): Promise<ResolvedConfig>;
}

export type ConfigSource = { type: "file"; path: string } | { type: "default" };
export type ResolvedConfig = { config: Config; provenance: Record<string, ConfigSource> };

export interface ConfigService extends ResolvedConfigReader {
  removeProject(key: string): Promise<void>;
  addProject(key: string, project: { name: string; path: string }): Promise<void>;
  set(key: string, value: string): Promise<void>;
  editGlobal(): Promise<ConfigDraft>;
  readHosts(): Promise<NonNullable<Config["hosts"]>>;
  addHost(alias: string, url: string): Promise<void>;
  updateHost(alias: string, changes: { url?: string; newAlias?: string }): Promise<void>;
  removeHost(alias: string): Promise<void>;
}

export type ConfigChanges = Readonly<Record<string, string | undefined>>;
export type ConfigSaveResult = "saved" | "previewed" | "unchanged" | "cancelled";

export interface ConfigDraft {
  readonly path: string;
  readonly config: Config;
  get(key: string): string | undefined;
  save(changes: ConfigChanges, confirmOverwrite: () => Promise<boolean>): Promise<ConfigSaveResult>;
}

export type FileConfigOptions = { pathsLowToHigh: readonly [string, ...string[]] };
export type ConfigContext = { repositoryPath?: string };

export function createConfigService(execution: Execution, context?: ConfigContext): ConfigService;
export function createConfigService(
  execution?: undefined,
  context?: ConfigContext,
): ResolvedConfigReader;
export function createConfigService(
  execution?: Execution,
  context: ConfigContext = {},
): ResolvedConfigReader {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

  const options: FileConfigOptions = { pathsLowToHigh: [join(configHome, "eden", "config.yaml")] };

  if (context.repositoryPath !== undefined) {
    options.pathsLowToHigh = [
      ...options.pathsLowToHigh,
      join(context.repositoryPath, ".eden", "config.yaml"),
      join(context.repositoryPath, ".eden", "config.local.yaml"),
    ];
  }

  return execution
    ? createFileConfigService({ ...options, execution })
    : createFileConfigService(options);
}

export function createFileConfigService(
  options: FileConfigOptions & { execution: Execution },
): ConfigService;
export function createFileConfigService(options: FileConfigOptions): ResolvedConfigReader;
export function createFileConfigService(
  options: FileConfigOptions & { execution?: Execution },
): ResolvedConfigReader {
  const [path] = options.pathsLowToHigh;
  const { execution } = options;

  const reader: ResolvedConfigReader = {
    async read() {
      const { config } = await reader.readWithProvenance();

      return config;
    },
    async readWithProvenance() {
      const merged: Record<string, unknown> = {};
      const provenance: Record<string, ConfigSource> = {};

      for (const layerPath of options.pathsLowToHigh) {
        const { parsed } = await readValidatedConfig(layerPath);

        mergeConfigLayer(
          merged,
          layerPath === path ? parsed : omitHosts(parsed),
          provenance,
          layerPath,
        );
      }

      const config = validateConfig(merged, path);

      if (!provenance.worktree_root) provenance.worktree_root = { type: "default" };

      return { config, provenance };
    },
  };

  if (!execution) return reader;

  const service: ConfigService = {
    ...reader,
    async removeProject(key) {
      const { text, parsed } = await readValidatedConfig(path);
      const config = validateConfig(parsed, path);
      if (!Object.hasOwn(config.projects ?? {}, key)) throw new Error("Project not found.");
      const document = parseDocument(text ?? "{}");
      document.deleteIn(["projects", key]);
      await saveProjectRegistry({ path, text, document, execution });
    },
    async readHosts() {
      const { parsed } = await readValidatedConfig(path);
      return validateConfig(parsed, path).hosts ?? {};
    },
    async addProject(key, project) {
      const { text, parsed } = await readValidatedConfig(path);
      const config = validateConfig(parsed, path);
      if (Object.hasOwn(config.projects ?? {}, key)) throw new Error("Project key already exists.");
      const document = parseDocument(text ?? "{}");
      if (!config.projects) document.set("projects", document.createNode({}));
      document.setIn(["projects", key], project);
      await saveProjectRegistry({ path, text, document, execution });
    },
    async addHost(alias, url) {
      const { text, parsed } = await readValidatedConfig(path);
      const config = validateConfig(parsed, path);
      if (Object.hasOwn(config.hosts ?? {}, alias)) throw new Error("Host alias already exists.");
      const document = parseDocument(text ?? "{}");
      if (!config.hosts) document.set("hosts", document.createNode({}));
      document.setIn(["hosts", alias], { url });
      await saveConfigMutation({ path, text, document, execution });
    },
    async updateHost(alias, changes) {
      const { text, parsed } = await readValidatedConfig(path);
      const config = validateConfig(parsed, path);
      const hosts = config.hosts ?? {};
      if (!Object.hasOwn(hosts, alias)) throw new Error("Host not found.");
      const newAlias = changes.newAlias ?? alias;
      if (newAlias !== alias && Object.hasOwn(hosts, newAlias))
        throw new Error("Host alias already exists.");
      const document = parseDocument(text ?? "{}");
      const current = hosts[alias];
      document.deleteIn(["hosts", alias]);
      document.setIn(["hosts", newAlias], {
        ...current,
        ...(changes.url === undefined ? {} : { url: changes.url }),
      });
      await saveConfigMutation({ path, text, document, execution });
    },
    async removeHost(alias) {
      const { text, parsed } = await readValidatedConfig(path);
      const config = validateConfig(parsed, path);
      if (!Object.hasOwn(config.hosts ?? {}, alias)) throw new Error("Host not found.");
      const document = parseDocument(text ?? "{}");
      document.deleteIn(["hosts", alias]);
      await saveConfigMutation({ path, text, document, execution });
    },
    async editGlobal() {
      const { text, parsed } = await readValidatedConfig(path);

      return {
        path,
        config: validateConfig(parsed, path),
        get(key) {
          let value: unknown = parsed;

          for (const part of configLeafPath(key)) {
            value =
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[part]
                : undefined;
          }

          return typeof value === "string" ? value : undefined;
        },
        async save(changes, confirmOverwrite) {
          const { edited, changed } = editDraft(text, changes);

          if (Object.keys(changed).length === 0) return "unchanged";

          validateConfig(parseConfigYaml(edited, path), path);

          if (
            !execution.dryRun &&
            (await readConfigFile(path)) !== text &&
            !(await confirmOverwrite())
          ) {
            return "cancelled";
          }

          await execution.mutate(
            {
              type: "config.setup",
              description: `Update global preferences in ${path}`,
              input: {
                path,
                changes: Object.fromEntries(
                  Object.entries(changed).map(([key, value]) => [key, value ?? null]),
                ),
              },
            },
            () => writeConfigFile(path, edited),
          );

          return execution.dryRun ? "previewed" : "saved";
        },
      };
    },
    async set(key, value) {
      const edited = await prepareConfigUpdate(path, key, value);

      await execution.mutate(
        {
          type: "config.set",
          description: `Set configuration ${key} to ${JSON.stringify(value)}`,
          input: { path, key, value },
        },
        () => writeConfigFile(path, edited),
      );
    },
  };

  return service;
}

function editDraft(text: string | undefined, changes: ConfigChanges) {
  const document = text === undefined ? new Document({}) : parseDocument(text);
  const changed: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(changes)) {
    const keys = configLeafPath(key);

    if (document.getIn(keys) === value) continue;

    changed[key] = value;
    if (value === undefined) document.deleteIn(keys);
    else document.setIn(keys, value);
  }

  return { edited: document.toString(), changed };
}

async function prepareConfigUpdate(path: string, key: string, value: string): Promise<string> {
  const { text } = await readValidatedConfig(path);
  const keys = configLeafPath(key);
  const edited = new ConfigYamlEditor(text).set(keys, value);

  validateConfig(parseConfigYaml(edited, path), path);

  return edited;
}

async function saveProjectRegistry({
  path,
  text,
  document,
  execution,
}: {
  path: string;
  text: string | undefined;
  document: ReturnType<typeof parseDocument>;
  execution: Execution;
}) {
  await saveConfigMutation({ path, text, document, execution, checkDuringDryRun: true });
}

async function saveConfigMutation({
  path,
  text,
  document,
  execution,
  checkDuringDryRun = false,
}: {
  path: string;
  text: string | undefined;
  document: ReturnType<typeof parseDocument>;
  execution: Execution;
  checkDuringDryRun?: boolean;
}) {
  const edited = document.toString();
  validateConfig(parseConfigYaml(edited, path), path);
  if ((!execution.dryRun || checkDuringDryRun) && (await readConfigFile(path)) !== text)
    throw new Error("Configuration changed. Try again.");
  await execution.mutate(
    {
      type: "config.setup",
      description: `Update global configuration in ${path}`,
      input: { path },
    },
    () => writeConfigFile(path, edited),
  );
}
