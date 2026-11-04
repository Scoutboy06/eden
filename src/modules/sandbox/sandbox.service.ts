import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSandboxPaths } from "./sandbox-paths";
import type { Execution } from "../execution";
import { HookFailure, HookService, type SandboxHookInput } from "../hook/hook.service";
import type { ConfigReader } from "../config/config.service";
import type { Config, SandboxProfile } from "../config/schema";
import { assertUnreachable } from "../../utils/assert-unreachable";
import { SandboxError } from "./errors";
import type {
  CreateSandboxInput,
  ExecSandboxInput,
  ExecSandboxResult,
  RunSandboxInput,
  SandboxProvider,
  SandboxProviderName,
  SandboxSummary,
} from "./provider";
import { DockerSandboxProvider } from "../../external/docker-sbx/provider";

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

  async exec(input: ExecSandboxInput): Promise<ExecSandboxResult | undefined> {
    validateSandboxInput(input.name);
    if (!input.argv.length || !input.argv[0]) {
      throw new SandboxError("SANDBOX_INVALID_INPUT", "Provide a command to execute.");
    }
    if (!(await this.provider.list()).some((sandbox) => sandbox.name === input.name)) {
      throw new SandboxError(
        "SANDBOX_NOT_FOUND",
        `Sandbox ${input.name} was not found using ${this.provider.name}. If it belongs to another provider, specify --provider.`,
      );
    }
    if (!this.provider.exec) {
      throw new SandboxError(
        "SANDBOX_PROVIDER_UNAVAILABLE",
        "Sandbox execution is unavailable for this provider.",
      );
    }
    let result: ExecSandboxResult | undefined;
    await this.execution.mutate(
      {
        type: "sandbox.exec",
        description: `Execute a command in sandbox ${input.name} using ${this.provider.name}`,
        input: {
          provider: this.provider.name,
          name: input.name,
          argv: input.argv,
          output: input.output,
        },
      },
      async () => {
        result = await this.provider.exec!(input);
      },
    );
    return result;
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

  async remove(name: string, force: boolean): Promise<void> {
    validateSandboxInput(name);
    const sandbox = (await this.provider.list()).find((entry) => entry.name === name);
    if (!sandbox) {
      throw new SandboxError(
        "SANDBOX_NOT_FOUND",
        `Sandbox ${name} was not found using ${this.provider.name}. If it belongs to another provider, specify --provider.`,
      );
    }
    if (sandbox.status !== "stopped" && !force) {
      throw new SandboxError(
        "SANDBOX_REMOVE_REQUIRES_FORCE",
        `Sandbox ${name} is ${sandbox.status}. Use --force to remove a sandbox that is running or has an unknown status.`,
      );
    }
    if (!this.provider.remove)
      throw new SandboxError(
        "SANDBOX_PROVIDER_UNAVAILABLE",
        "Sandbox removal is unavailable for this provider.",
      );

    const path = force ? undefined : await this.hooks.discover("sandbox.remove.pre");
    if (path) {
      this.onHook?.();
      const input: SandboxHookInput = {
        request: { name },
        context: { cwd: process.cwd() },
        sandbox: { name, provider: this.provider.name, status: sandbox.status },
      };
      await this.hooks.run("sandbox.remove.pre", path, input, input.context.cwd, "pre", "empty");
    }

    await this.execution.mutate(
      {
        type: "sandbox.remove",
        description: `Remove sandbox ${name} using ${this.provider.name}`,
        input: { provider: this.provider.name, name, force },
      },
      () => this.provider.remove!(name, force),
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
    if (input.workspace?.mode === "host" && this.profile?.workspace?.mode !== "host") {
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "Host workspace mode must be configured explicitly in a sandbox profile.",
      );
    }

    const resolved = resolveCreateInput(input, this.profile);
    validateSandboxInput(resolved.name, resolved.image);
    await resolveSandboxPaths(resolved, path);
    const warnings = workspaceWarnings(resolved);
    for (const warning of warnings) this.onWarning?.(warning);

    await this.provider.preflight(resolved);
    const hookInput = this.createHookInput(resolved);
    const [pre, post] = await Promise.all([
      this.hooks.discover("sandbox.create.pre"),
      this.hooks.discover("sandbox.create.post"),
    ]);
    await this.runCreatePreHook(pre, hookInput);

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

    await this.runCreatePostHook(post, hookInput);

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

  private async runCreatePreHook(path: string | undefined, input: SandboxHookInput): Promise<void> {
    if (!path) return;
    this.onHook?.();
    await this.hooks.run("sandbox.create.pre", path, input, input.context.cwd, "pre", "empty");
  }

  private async runCreatePostHook(
    path: string | undefined,
    input: SandboxHookInput,
  ): Promise<void> {
    if (!path) return;
    this.onHook?.();
    try {
      await this.hooks.run("sandbox.create.post", path, input, input.context.cwd, "post");
    } catch (error) {
      if (error instanceof HookFailure) {
        throw new HookFailure({
          ...error.detail,
          message: `${error.message}. Sandbox ${input.request.name} was created and is left in place.`,
        });
      }
      throw error;
    }
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
    interactiveCreate?: boolean;
    providerFactory?: typeof createSandboxProvider;
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
    (options.providerFactory ?? createSandboxProvider)(
      name,
      onCreateOutput,
      options.interactiveCreate,
    ),
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
  interactiveCreate?: boolean,
): SandboxProvider {
  switch (name) {
    case "docker-sbx":
      return new DockerSandboxProvider(onCreateOutput, { interactiveCreate });
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

function workspaceWarnings(input: CreateSandboxInput): string[] {
  if (
    input.workspace?.mode === "host" ||
    Object.values(input.mounts ?? {}).some((mount) => !mount.readonly)
  ) {
    return [
      "Host workspace or mount is writable: the agent can change hooks, Git configuration, and build output that may run on the host later.",
    ];
  }
  return [];
}

function resolveCreateInput(
  input: CreateSandboxInput,
  profile?: SandboxProfile,
): CreateSandboxInput {
  const settings = {
    workspace: input.workspace ?? profile?.workspace,
    mounts: input.mounts ?? profile?.mounts,
    agent: input.agent ?? profile?.agent,
    pull: input.pull ?? profile?.pull,
    disk: input.disk ?? profile?.disk,
    kits: (input.kits ?? profile?.kits)?.map(resolveKitReference),
    mcpServers: input.mcpServers ?? profile?.mcp_servers,
    kitArgs: input.kitArgs ?? profile?.kit_args,
  };
  const defined = Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  );

  return { ...input, image: input.image ?? profile?.template, ...defined };
}

function expandWorkspacePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2).replaceAll("\\", "/"));
  }

  return path;
}

function resolveKitReference(reference: string): string {
  if (reference.startsWith("~/") || reference.startsWith("~\\")) {
    return expandWorkspacePath(reference);
  }

  if (/^\.{1,2}[\\/]/.test(reference)) {
    return resolve(reference.replaceAll("\\", "/"));
  }

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
