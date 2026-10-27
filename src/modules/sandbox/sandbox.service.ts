import type { Execution } from "../execution";
import type { ConfigReader } from "../config/config.service";
import { assertUnreachable } from "../../utils/assert-unreachable";
import { SandboxError } from "./errors";
import type { CreateSandboxInput, SandboxProvider, SandboxProviderName } from "./provider";
import { DockerSandboxProvider } from "./providers/docker-sbx";

export class SandboxService {
  get providerName(): SandboxProviderName {
    return this.provider.name;
  }

  constructor(
    private readonly execution: Execution,
    private readonly provider: SandboxProvider,
  ) {}

  async run(name: string): Promise<number> {
    if (!name.trim()) {
      throw new SandboxError("SANDBOX_INVALID_INPUT", "Sandbox name must not be empty.");
    }

    await this.provider.requireExisting(name);
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
    if (!input.name.trim() || (input.image !== undefined && !input.image.trim())) {
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "Sandbox name and supplied image must not be empty.",
      );
    }

    await this.provider.preflight();

    await this.execution.mutate(
      {
        type: "sandbox.create",
        description: `Create sandbox ${input.name} using ${this.provider.name}`,
        input: { provider: this.provider.name, ...input },
      },
      () => this.provider.create(input),
    );
  }
}

export async function createSandboxService(
  execution: Execution,
  providerName: SandboxProviderName | undefined,
  config: ConfigReader,
  onCreateOutput?: (text: string) => void,
): Promise<SandboxService> {
  const name = providerName ?? (await config.read()).sandbox?.default_provider;

  if (name === undefined) {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      "Choose a sandbox provider with --provider, or set a default with eden setup.",
    );
  }

  return new SandboxService(execution, createSandboxProvider(name, onCreateOutput));
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
