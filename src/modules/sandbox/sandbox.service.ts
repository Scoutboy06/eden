import { resolveSandboxPaths } from "./sandbox-paths";
import type { Execution } from "../execution";
import { HookFailure, HookService, type SandboxHookInput } from "../hook/hook.service";
import type { ConfigReader } from "../config/config.service";
import type { Config, SandboxProfile } from "../config/schema";
import { assertUnreachable } from "../../utils/assert-unreachable";
import { SandboxError } from "./errors";
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
    const sandboxes = await this.provider.list();
    const sandbox = sandboxes.find((entry) => entry.name === name);

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
        const alreadyStopped = sandbox.status === "stopped";
        if (!alreadyStopped) {
          await this.provider.stop(name);
        }
      },
    );
  }

  async remove(name: string, force: boolean): Promise<void> {
    validateSandboxInput(name);
    const sandboxes = await this.provider.list();
    const sandbox = sandboxes.find((entry) => entry.name === name);
    if (!sandbox) {
      throw new SandboxError(
        "SANDBOX_NOT_FOUND",
        `Sandbox ${name} was not found using ${this.provider.name}. If it belongs to another provider, specify --provider.`,
      );
    }
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

    await this.execution.mutate(
      {
        type: "sandbox.create",
        description: describeCreation(this.provider.name, resolved),
        input: createAuditInput(this.provider.name, resolved, warnings, this.profile),
      },
      () => this.provider.create(resolved),
    );

    await this.runCreatePostHook(post, hookInput);

    return { warnings };
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
