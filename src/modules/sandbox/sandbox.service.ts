import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSandboxPaths } from "./sandbox-paths";
import type { Execution } from "../execution";
import { HookService, type SandboxHookInput } from "../hook/hook.service";
import type { ConfigReader } from "../config/config.service";
import type { Config, SandboxProfile } from "../config/schema";
import { assertUnreachable } from "../../utils/assert-unreachable";
import { SandboxError } from "./errors";
import type {
  CreateSandboxInput,
  RunSandboxInput,
  SandboxProvider,
  SandboxProviderName,
  SandboxSummary,
} from "./provider";
import { DockerSandboxProvider } from "./providers/docker-sbx";

export class SandboxService {
  get providerName(): SandboxProviderName {
    return this.provider.name;
  }

  constructor(
    private readonly execution: Execution,
    private readonly provider: SandboxProvider,
    private readonly profile?: SandboxProfile & { name: string },
    private readonly onWarning?: (warning: string) => void,
    private readonly hooks: HookService = new HookService(execution),
    private readonly onHook?: () => void,
  ) {}

  list(): Promise<SandboxSummary[]> {
    return this.provider.list();
  }

  async stop(name: string): Promise<void> {
    validateSandboxInput(name);
    const sandbox = (await this.provider.list()).find((sandbox) => sandbox.name === name);

    if (!sandbox) {
      throw new SandboxError(
        "SANDBOX_NOT_FOUND",
        `Sandbox ${name} was not found using ${this.provider.name}. If it belongs to another provider, specify --provider.`,
      );
    }

    await this.execution.mutate(
      {
        type: "sandbox.stop",
        description: `Stop sandbox ${name} using ${this.provider.name}`,
        input: { provider: this.provider.name, name },
      },
      async () => {
        if (sandbox.status !== "stopped") await this.provider.stop(name);
      },
    );
  }

  async run(input: RunSandboxInput): Promise<number> {
    validateSandboxInput(input.name);
    const { name } = input;
    const sandboxes = await this.provider.list();
    const exists = sandboxes.some((sandbox) => sandbox.name === name);

    if (!exists) {
      throw new SandboxError(
        "SANDBOX_NOT_FOUND",
        `Sandbox ${name} was not found using ${this.provider.name}. If it belongs to another provider, specify --provider. Create it explicitly with eden sbx create.`,
      );
    }

    let exitCode = 0;

    await this.execution.mutate(
      {
        type: "sandbox.run",
        description: `Attach to sandbox ${name} using ${this.provider.name}`,
        input: { provider: this.provider.name, name },
      },
      async () => {
        exitCode = await this.provider.run(name);
      },
    );

    return exitCode;
  }

  async create(input: CreateSandboxInput, path?: string): Promise<{ warnings: string[] }> {
    if (input.workspace?.mode === "host" && this.profile?.workspace?.mode !== "host")
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "Host workspace mode must be configured explicitly in a sandbox profile.",
      );
    const resolved = resolveCreateInput(input, this.profile);
    validateSandboxInput(resolved.name, resolved.image);
    await resolveSandboxPaths(resolved, path);
    const warnings =
      resolved.workspace?.mode === "host" ||
      Object.values(resolved.mounts ?? {}).some((mount) => !mount.readonly)
        ? [
            "Host workspace or mount is writable: the agent can change hooks, Git configuration, and build output that may run on the host later.",
          ]
        : [];
    for (const warning of warnings) this.onWarning?.(warning);
    await this.provider.preflight(resolved);
    const hookInput = this.createHookInput(resolved);
    const pre = await this.hooks.discover("sandbox.create.pre");
    if (pre) {
      this.onHook?.();
      await this.hooks.run(
        "sandbox.create.pre",
        pre,
        hookInput,
        hookInput.context.cwd,
        "pre",
        "empty",
      );
    }

    await this.execution.mutate(
      {
        type: "sandbox.create",
        description: describeCreation(this.provider.name, resolved),
        input: {
          provider: this.provider.name,
          ...resolved,
          ...(warnings.length ? { warnings } : {}),
          ...(this.profile === undefined ? {} : { profile: this.profile.name }),
        },
      },
      () => this.provider.create(resolved),
    );
    return { warnings };
  }

  private createHookInput(resolved: CreateSandboxInput): SandboxHookInput {
    const profile = this.profile ? { profile: this.profile.name } : {};
    return {
      request: { name: resolved.name, ...profile },
      context: { cwd: process.cwd() },
      sandbox: { provider: this.provider.name, ...resolved, ...profile },
    };
  }
}

export async function createSandboxService(
  execution: Execution,
  providerName: SandboxProviderName | undefined,
  config: ConfigReader,
  onCreateOutput?: (text: string) => void,
  profileName?: string,
  options: {
    useDefaultProfile?: boolean;
    onWarning?: (warning: string) => void;
    hooks?: HookService;
    onHook?: () => void;
  } = {},
): Promise<SandboxService> {
  const settings =
    providerName === undefined || profileName !== undefined || options.useDefaultProfile
      ? (await config.read()).sandbox
      : undefined;
  const selectedProfile =
    profileName ?? (options.useDefaultProfile ? settings?.default_profile : undefined);
  const profile =
    selectedProfile === undefined ? undefined : resolveProfile(settings, selectedProfile);
  const name = providerName ?? profile?.provider ?? settings?.default_provider;

  if (name === undefined) {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      "Choose a sandbox provider with --provider, or set a default with eden setup.",
    );
  }

  return new SandboxService(
    execution,
    createSandboxProvider(name, onCreateOutput),
    selectedProfile === undefined ? undefined : { ...profile, name: selectedProfile },
    options.onWarning,
    options.hooks,
    options.onHook,
  );
}

function resolveProfile(settings: Config["sandbox"], name: string) {
  const profiles = settings?.profiles ?? {};

  if (!Object.hasOwn(profiles, name)) {
    const available = Object.keys(profiles)
      .sort()
      .map((key) => JSON.stringify(key))
      .join(", ");

    throw new SandboxError(
      "SANDBOX_PROFILE_NOT_FOUND",
      `Unknown sandbox profile ${JSON.stringify(name)}. Configured profiles: ${available || "none"}.`,
    );
  }

  return profiles[name]!;
}

export function createSandboxProvider(
  name: SandboxProviderName,
  onCreateOutput?: (text: string) => void,
): SandboxProvider {
  switch (name) {
    case "docker-sbx":
      return new DockerSandboxProvider(onCreateOutput);
    default:
      return assertUnreachable(name, "Unsupported sandbox provider");
  }
}

function validateSandboxInput(name: string, image?: string): void {
  if (!name.trim() || (image !== undefined && !image.trim())) {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      "Sandbox name and supplied image must not be empty.",
    );
  }
}

function resolveCreateInput(
  input: CreateSandboxInput,
  profile?: SandboxProfile,
): CreateSandboxInput {
  const kits = (input.kits ?? profile?.kits)?.map(resolveKitReference);
  const kitArgs = input.kitArgs ?? profile?.kit_args;
  const mcpServers = input.mcpServers ?? profile?.mcp_servers;

  return {
    ...input,
    image: input.image ?? profile?.template,
    ...((input.mounts ?? profile?.mounts) ? { mounts: input.mounts ?? profile?.mounts } : {}),
    ...((input.pull ?? profile?.pull) ? { pull: input.pull ?? profile?.pull } : {}),
    ...((input.disk ?? profile?.disk) ? { disk: input.disk ?? profile?.disk } : {}),
    ...((input.workspace ?? profile?.workspace)
      ? { workspace: input.workspace ?? profile?.workspace }
      : {}),
    ...((input.agent ?? profile?.agent) ? { agent: input.agent ?? profile?.agent } : {}),
    ...(kits === undefined ? {} : { kits }),
    ...(kitArgs === undefined ? {} : { kitArgs }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}

function resolveKitReference(reference: string): string {
  if (reference.startsWith("~/") || reference.startsWith("~\\"))
    return join(homedir(), reference.slice(2).replaceAll("\\", "/"));
  if (/^\.{1,2}[\\/]/.test(reference)) return resolve(reference.replaceAll("\\", "/"));
  return reference;
}

function describeCreation(provider: string, input: CreateSandboxInput): string {
  const workspace = input.workspace?.path
    ? ` with ${input.workspace.mode} workspace ${input.workspace.path}`
    : "";
  const kits = input.kits?.length ? `\n  Kits: ${input.kits.join(", ")}` : "";
  const mounts = Object.entries(input.mounts ?? {})
    .map(
      ([name, mount]) =>
        `\n  Mount ${name}: ${mount.path}${mount.readonly ? " (read-only)" : " (writable)"}`,
    )
    .join("");
  const args = Object.entries(input.kitArgs ?? {})
    .map(([name, value]) => `\n  Kit argument ${name}: ${String(value)}`)
    .join("");
  const mcp = input.mcpServers?.length
    ? `\n  Static MCP servers: ${input.mcpServers.join(", ")}`
    : "";
  const pull = input.pull ? `\n  Pull: ${input.pull}` : "";
  const disk = input.disk
    ? `\n  Disk: ${Object.entries(input.disk)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`
    : "";
  return `Create sandbox ${input.name} using ${provider}${workspace}${kits}${mounts}${args}${mcp}${pull}${disk}`;
}
