import type { Execution } from "../execution";
import { assertUnreachable } from "../../utils/assert-unreachable";
import { SandboxError } from "./errors";
import type { CreateSandboxInput, SandboxProvider, SandboxProviderName } from "./provider";
import { DockerSandboxProvider } from "./providers/docker-sbx";

export class SandboxService {
  constructor(
    private readonly execution: Execution,
    private readonly provider: SandboxProvider,
  ) {}

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

export function createSandboxService(
  execution: Execution,
  providerName: SandboxProviderName,
  onCreateOutput?: (text: string) => void,
): SandboxService {
  return new SandboxService(execution, resolveSandboxProvider(providerName, onCreateOutput));
}

function resolveSandboxProvider(
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
