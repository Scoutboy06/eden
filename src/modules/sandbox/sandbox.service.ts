import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findRepositoryPath } from "../config/repository";
import type { Execution } from "../execution";
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
    const workspace = await resolveWorkspace(resolved.workspace, path);
    if (workspace !== undefined) resolved.workspace = workspace;
    const warnings =
      resolved.workspace?.mode === "host"
        ? [
            "Host workspace or mount is writable: the agent can change hooks, Git configuration, and build output that may run on the host later.",
          ]
        : [];
    for (const warning of warnings) this.onWarning?.(warning);
    await this.provider.preflight(resolved);

    await this.execution.mutate(
      {
        type: "sandbox.create",
        description: `Create sandbox ${input.name} using ${this.provider.name}${resolved.workspace?.path ? ` with ${resolved.workspace.mode} workspace ${resolved.workspace.path}` : ""}`,
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
}

export async function createSandboxService(
  execution: Execution,
  providerName: SandboxProviderName | undefined,
  config: ConfigReader,
  onCreateOutput?: (text: string) => void,
  profileName?: string,
  options: { useDefaultProfile?: boolean; onWarning?: (warning: string) => void } = {},
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
  const kits = input.kits ?? profile?.kits;
  const kitArgs = input.kitArgs ?? profile?.kit_args;

  return {
    ...input,
    image: input.image ?? profile?.template,
    ...((input.workspace ?? profile?.workspace)
      ? { workspace: input.workspace ?? profile?.workspace }
      : {}),
    ...((input.agent ?? profile?.agent) ? { agent: input.agent ?? profile?.agent } : {}),
    ...(kits === undefined ? {} : { kits }),
    ...(kitArgs === undefined ? {} : { kitArgs }),
  };
}

async function resolveWorkspace(
  workspace: CreateSandboxInput["workspace"],
  explicitPath?: string,
): Promise<CreateSandboxInput["workspace"]> {
  if (!workspace || workspace.mode === "none") {
    if (explicitPath !== undefined || workspace?.path !== undefined)
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "A workspace path requires profile workspace mode clone or host.",
      );
    return workspace;
  }
  const configured = explicitPath ?? workspace.path;
  if (configured !== undefined && !configured.trim())
    throw new SandboxError("SANDBOX_INVALID_INPUT", "Workspace path must not be empty.");
  const expanded =
    configured === "~"
      ? homedir()
      : configured?.startsWith("~/") ||
          (process.platform === "win32" && configured?.startsWith("~\\"))
        ? join(homedir(), configured.slice(2))
        : configured;
  const path = expanded === undefined ? await findRepositoryPath(process.cwd()) : resolve(expanded);
  if (!path)
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      "Workspace requires --path, a profile path, or a current repository.",
    );
  const directory = await stat(path).catch(() => undefined);
  if (!directory?.isDirectory())
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      `Workspace path is not an existing directory: ${path}`,
    );
  return { mode: workspace.mode, path };
}
