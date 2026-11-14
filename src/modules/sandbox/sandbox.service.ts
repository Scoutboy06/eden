import { mkdir } from "node:fs/promises";
import { resolveSandboxPaths } from "./sandbox-paths";
import type { Execution } from "../execution";
import { HookFailure, HookService, type SandboxHookInput } from "../hook/hook.service";
import type { ConfigReader } from "../config/config.service";
import type { Config, SandboxProfile } from "../config/schema";
import { assertUnreachable } from "../../utils/assert-unreachable";
import { SandboxError } from "./errors";
import {
  FileSandboxProfileRegistry,
  type SandboxProfileRecord,
  type SandboxProfileRegistry,
} from "./profile-registry";
import { findCheckout } from "./sandbox-checkout";
import { inferSandbox, type InferredSandbox } from "./sandbox-inference";
import {
  createAuditInput,
  describeCreation,
  resolveCreateInput,
  workspaceWarnings,
} from "./sandbox-creation";
import type {
  CreateSandboxInput,
  ExecSandboxInput,
  ExecSandboxResult,
  RunSandboxInput,
  SandboxProvider,
  SandboxProviderName,
  SandboxSummary,
  SshAccess,
} from "./provider";
import { DockerSandboxProvider } from "../../external/docker-sbx/provider";

export type ShellSandboxInput = { name: string; cwd?: string };

const defaultShellCommand = ["bash", "-l"];

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
    private readonly registry: SandboxProfileRegistry = new FileSandboxProfileRegistry(),
  ) {}

  async list(): Promise<SandboxSummary[]> {
    const sandboxes = await this.provider.list();
    const records = await this.registry.read(this.provider.name).catch(() => undefined);

    return sandboxes.map(({ createdAt, ...sandbox }) => {
      const record =
        records !== undefined && Object.hasOwn(records, sandbox.name)
          ? records[sandbox.name]
          : undefined;
      const profile = record && isCurrentRecord(record, createdAt) ? record.profile : undefined;

      return profile === undefined ? sandbox : { ...sandbox, profile };
    });
  }

  async profileOf(name: string): Promise<string | undefined> {
    validateSandboxInput(name);
    const sandboxes = await this.list();

    return sandboxes.find((sandbox) => sandbox.name === name)?.profile;
  }

  async infer(cwd: string): Promise<InferredSandbox> {
    const checkout = await findCheckout(cwd);

    return inferSandbox(await this.provider.list(), checkout, this.provider.name);
  }

  async exec(input: ExecSandboxInput): Promise<ExecSandboxResult | undefined> {
    validateSandboxInput(input.name);
    const hasCommand = input.argv.length > 0 && Boolean(input.argv[0]);
    if (!hasCommand) {
      throw new SandboxError("SANDBOX_INVALID_INPUT", "Provide a command to execute.");
    }
    const sandboxes = await this.provider.list();
    const sandboxExists = sandboxes.some((sandbox) => sandbox.name === input.name);
    if (!sandboxExists) {
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
    const providerName = this.provider.name;
    await this.execution.mutate(
      {
        type: "sandbox.exec",
        description: `Execute a command in sandbox ${input.name} using ${providerName}`,
        input: {
          provider: providerName,
          name: input.name,
          argv: input.argv,
          output: input.output,
          ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
          ...(input.tty ? { tty: true } : {}),
        },
      },
      async () => {
        result = await this.provider.exec!(input);
      },
    );
    return result;
  }

  async shell(input: ShellSandboxInput): Promise<ExecSandboxResult | undefined> {
    validateSandboxInput(input.name);
    const sandbox = await this.requireSandbox(input.name);
    const settings = this.profile?.shell;

    if (sandbox.status === "stopped" && this.provider.start) {
      await this.startSandbox(sandbox);
    }

    return this.exec({
      name: input.name,
      argv: settings?.command ?? defaultShellCommand,
      output: "inherit",
      tty: true,
      workdir: input.cwd ?? settings?.cwd,
    });
  }

  async ssh(name: string): Promise<SshAccess & { status: string }> {
    validateSandboxInput(name);

    if (!this.provider.sshAccess) {
      throw new SandboxError(
        "SANDBOX_PROVIDER_UNAVAILABLE",
        "SSH access is unavailable for this provider.",
      );
    }
    const sandbox = await this.requireSandbox(name);

    return { ...this.provider.sshAccess(name), status: sandbox.status };
  }

  async start(name: string): Promise<{ started: boolean }> {
    validateSandboxInput(name);

    return this.startSandbox(await this.requireSandbox(name));
  }

  async stop(name: string): Promise<void> {
    validateSandboxInput(name);
    const sandbox = await this.requireSandbox(name);

    await this.execution.mutate(
      {
        type: "sandbox.stop",
        description: `Stop sandbox ${name} using ${this.provider.name}`,
        input: { provider: this.provider.name, name },
      },
      async () => {
        const alreadyStopped = sandbox.status === "stopped";
        if (!alreadyStopped) {
          await this.provider.stop(name);
        }
      },
    );
  }

  async remove(name: string, force: boolean): Promise<void> {
    validateSandboxInput(name);
    const sandbox = await this.requireSandbox(name);
    const sandboxIsRunningOrUnknown = sandbox.status !== "stopped";
    if (sandboxIsRunningOrUnknown && !force) {
      throw new SandboxError(
        "SANDBOX_REMOVE_REQUIRES_FORCE",
        `Sandbox ${name} is ${sandbox.status}. Use --force to remove a sandbox that is running or has an unknown status.`,
      );
    }
    const canRemove = this.provider.remove !== undefined;
    if (!canRemove) {
      throw new SandboxError(
        "SANDBOX_PROVIDER_UNAVAILABLE",
        "Sandbox removal is unavailable for this provider.",
      );
    }

    let path: string | undefined;
    if (!force) {
      path = await this.hooks.discover("sandbox.remove.pre");
    }
    if (path) {
      this.onHook?.();
      const cwd = process.cwd();
      const input: SandboxHookInput = {
        request: { name },
        context: { cwd },
        sandbox: { name, provider: this.provider.name, status: sandbox.status },
      };
      await this.hooks.run("sandbox.remove.pre", path, input, cwd, "pre", "empty");
    }

    await this.execution.mutate(
      {
        type: "sandbox.remove",
        description: `Remove sandbox ${name} using ${this.provider.name}`,
        input: { provider: this.provider.name, name, force },
      },
      async () => {
        await this.provider.remove!(name, force);
        await this.forgetProfile(name);
      },
    );
  }

  async run(input: RunSandboxInput): Promise<number> {
    validateSandboxInput(input.name);
    const { name } = input;
    const sandboxes = await this.provider.list();
    const sandbox = sandboxes.find((entry) => entry.name === name);

    if (!sandbox) {
      throw new SandboxError(
        "SANDBOX_NOT_FOUND",
        `Sandbox ${name} was not found using ${this.provider.name}. If it belongs to another provider, specify --provider. Create it explicitly with eden sbx create.`,
      );
    }

    const startsFirst =
      sandbox.status === "stopped" &&
      this.provider.start !== undefined &&
      (await this.hooks.discover("sandbox.start.post")) !== undefined;
    if (startsFirst) await this.startSandbox(sandbox);

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
    const requestedHostWorkspace = input.workspace?.mode === "host";
    const profileAllowsHostWorkspace = this.profile?.workspace?.mode === "host";
    if (requestedHostWorkspace && !profileAllowsHostWorkspace) {
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "Host workspace mode must be configured explicitly in a sandbox profile.",
      );
    }

    const resolved = resolveCreateInput(input, this.profile);
    validateSandboxInput(resolved.name, resolved.image);
    await resolveSandboxPaths(resolved, path);
    const warnings = workspaceWarnings(resolved);
    for (const warning of warnings) {
      this.onWarning?.(warning);
    }

    await this.provider.preflight(resolved);
    const hookInput = this.createHookInput(resolved);
    const [pre, post] = await Promise.all([
      this.hooks.discover("sandbox.create.pre"),
      this.hooks.discover("sandbox.create.post"),
    ]);
    await this.runCreatePreHook(pre, hookInput);
    await this.createMountDirectories(resolved);

    await this.execution.mutate(
      {
        type: "sandbox.create",
        description: describeCreation(this.provider.name, resolved),
        input: createAuditInput(this.provider.name, resolved, warnings, this.profile),
      },
      async () => {
        await this.provider.create(resolved);
        await this.recordProfile(resolved.name);
      },
    );

    await this.runCreatePostHook(post, hookInput);

    return { warnings };
  }

  private async startSandbox(sandbox: SandboxSummary): Promise<{ started: boolean }> {
    const { name } = sandbox;
    const provider = this.provider;
    if (!provider.start) {
      throw new SandboxError(
        "SANDBOX_PROVIDER_UNAVAILABLE",
        "Starting sandboxes is unavailable for this provider.",
      );
    }

    const started = sandbox.status !== "running";
    const post = started ? await this.hooks.discover("sandbox.start.post") : undefined;
    await this.execution.mutate(
      {
        type: "sandbox.start",
        description: `Start sandbox ${name} using ${provider.name}`,
        input: { provider: provider.name, name },
      },
      async () => {
        if (started) await provider.start!(name);
      },
    );
    await this.runStartPostHook(post, name);

    return { started };
  }

  private async requireSandbox(name: string): Promise<SandboxSummary> {
    const sandboxes = await this.provider.list();
    const sandbox = sandboxes.find((entry) => entry.name === name);
    if (!sandbox) {
      throw new SandboxError(
        "SANDBOX_NOT_FOUND",
        `Sandbox ${name} was not found using ${this.provider.name}. If it belongs to another provider, specify --provider.`,
      );
    }

    return sandbox;
  }

  private async recordProfile(name: string): Promise<void> {
    if (this.profile === undefined) {
      await this.forgetProfile(name);
      return;
    }

    try {
      await this.registry.record(this.provider.name, name, {
        profile: this.profile.name,
        recordedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.onWarning?.(
        `Could not remember profile ${this.profile.name} for sandbox ${name}: ${errorMessage(error)}`,
      );
    }
  }

  private async forgetProfile(name: string): Promise<void> {
    try {
      await this.registry.forget(this.provider.name, name);
    } catch (error) {
      this.onWarning?.(
        `Could not forget the recorded profile of sandbox ${name}: ${errorMessage(error)}`,
      );
    }
  }

  private async createMountDirectories(input: CreateSandboxInput): Promise<void> {
    for (const [name, mount] of Object.entries(input.mounts ?? {})) {
      if (!mount.create) continue;

      await this.execution.mutate(
        {
          type: "sandbox.mount.create",
          description: `Create directory for mount ${name}: ${mount.path}`,
          input: { name, path: mount.path },
        },
        async () => {
          await mkdir(mount.path, { recursive: true });
        },
      );
    }
  }

  private createHookInput(resolved: CreateSandboxInput): SandboxHookInput {
    const profileName = this.profile?.name;
    const request: SandboxHookInput["request"] = { name: resolved.name };
    const sandbox: Record<string, unknown> = { provider: this.provider.name, ...resolved };
    if (profileName !== undefined) {
      request.profile = profileName;
      sandbox.profile = profileName;
    }

    return {
      request,
      context: { cwd: process.cwd() },
      sandbox,
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
    await this.runPostHook(
      "sandbox.create.post",
      path,
      input,
      `Sandbox ${input.request.name} was created and is left in place.`,
    );
  }

  private async runStartPostHook(path: string | undefined, name: string): Promise<void> {
    if (!path) return;
    const profile = await this.profileOf(name).catch(() => undefined);
    const request: SandboxHookInput["request"] = { name };
    const sandbox: Record<string, unknown> = {
      name,
      provider: this.provider.name,
      status: "running",
    };
    if (profile !== undefined) {
      request.profile = profile;
      sandbox.profile = profile;
    }

    await this.runPostHook(
      "sandbox.start.post",
      path,
      { request, context: { cwd: process.cwd() }, sandbox },
      `Sandbox ${name} was started and is left running.`,
    );
  }

  private async runPostHook(
    hook: string,
    path: string | undefined,
    input: SandboxHookInput,
    outcome: string,
  ): Promise<void> {
    if (!path) return;
    this.onHook?.();
    try {
      await this.hooks.run(hook, path, input, input.context.cwd, "post");
    } catch (error) {
      if (error instanceof HookFailure) {
        throw new HookFailure({ ...error.detail, message: `${error.message}. ${outcome}` });
      }
      throw error;
    }
  }
}

export type SandboxSelection = {
  provider?: SandboxProviderName;
  profile?: string;
  useDefaultProfile?: boolean;
};

export type SandboxServicePresentation = {
  onCreateOutput?: (text: string) => void;
  onWarning?: (warning: string) => void;
  onHook?: () => void;
  interactiveCreate?: boolean;
};

export function createSandboxServiceFactory(
  execution: Execution,
  config: ConfigReader,
  presentation: SandboxServicePresentation = {},
  hooks: HookService = new HookService(execution),
  providerFactory: typeof createSandboxProvider = createSandboxProvider,
  registry: SandboxProfileRegistry = new FileSandboxProfileRegistry(),
): (selection?: SandboxSelection) => Promise<SandboxService> {
  return async (selection = {}) => {
    const { provider: providerName, profile: profileName, useDefaultProfile } = selection;
    const shouldReadSettings =
      providerName === undefined || profileName !== undefined || useDefaultProfile === true;
    let settings: Config["sandbox"] | undefined;
    if (shouldReadSettings) {
      const configValue = await config.read();
      settings = configValue.sandbox;
    }

    let selectedProfile = profileName;
    if (selectedProfile === undefined && useDefaultProfile) {
      selectedProfile = settings?.default_profile;
    }

    let profile: SandboxProfile | undefined;
    let namedProfile: (SandboxProfile & { name: string }) | undefined;
    if (selectedProfile !== undefined) {
      profile = resolveProfile(settings, selectedProfile);
      namedProfile = { ...profile, name: selectedProfile };
    }

    const configuredProvider = profile?.provider ?? settings?.default_provider;
    const name = providerName ?? configuredProvider;

    if (name === undefined) {
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "Choose a sandbox provider with --provider, or set a default with eden setup.",
      );
    }

    const provider = providerFactory(
      name,
      presentation.onCreateOutput,
      presentation.interactiveCreate,
    );
    return new SandboxService(
      execution,
      provider,
      namedProfile,
      presentation.onWarning,
      hooks,
      presentation.onHook,
      registry,
    );
  };
}

function resolveProfile(settings: Config["sandbox"], name: string) {
  const profiles = settings?.profiles ?? {};

  if (!Object.hasOwn(profiles, name)) {
    const available = Object.keys(profiles)
      .sort()
      .map((key) => JSON.stringify(key))
      .join(", ");
    const profileName = JSON.stringify(name);
    const configuredProfiles = available || "none";

    throw new SandboxError(
      "SANDBOX_PROFILE_NOT_FOUND",
      `Unknown sandbox profile ${profileName}. Configured profiles: ${configuredProfiles}.`,
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
  const isNameBlank = name.trim().length === 0;
  const isImageBlank = image !== undefined && image.trim().length === 0;

  if (isNameBlank || isImageBlank) {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      "Sandbox name and supplied image must not be empty.",
    );
  }
}

function isCurrentRecord(record: SandboxProfileRecord, createdAt: string | undefined): boolean {
  if (createdAt === undefined) return true;

  const created = Date.parse(createdAt);
  const recorded = Date.parse(record.recordedAt);

  return Number.isNaN(created) || Number.isNaN(recorded) || created <= recorded;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
