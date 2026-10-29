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
        `Sandbox ${name} was not found using ${this.provider.name}.`,
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
        `Sandbox ${name} was not found using ${this.provider.name}. Create it explicitly with eden sbx create.`,
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

  async create(input: CreateSandboxInput): Promise<void> {
    const resolved = resolveCreateInput(input, this.profile);
    validateSandboxInput(resolved.name, resolved.image);
    await this.provider.preflight();

    await this.execution.mutate(
      {
        type: "sandbox.create",
        description: `Create sandbox ${input.name} using ${this.provider.name}`,
        input: {
          provider: this.provider.name,
          ...resolved,
          ...(this.profile === undefined ? {} : { profile: this.profile.name }),
        },
      },
      () => this.provider.create(resolved),
    );
  }
}

export async function createSandboxService(
  execution: Execution,
  providerName: SandboxProviderName | undefined,
  config: ConfigReader,
  onCreateOutput?: (text: string) => void,
  profileName?: string,
  options: { useDefaultProfile?: boolean } = {},
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
    ...(kits === undefined ? {} : { kits }),
    ...(kitArgs === undefined ? {} : { kitArgs }),
  };
}
