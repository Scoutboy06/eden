import type { Execution } from "../execution";
import { PostHookFailure } from "../hook/hook.service";
import { SandboxError } from "./errors";
import type { SandboxProvider } from "./provider";

export type SetupNetworkContext = {
  execution: Execution;
  provider: SandboxProvider;
  onWarning?: (warning: string) => void;
};

export async function withSetupNetwork(
  context: SetupNetworkContext,
  name: string,
  hosts: string[],
  run: () => Promise<void>,
): Promise<void> {
  const { execution, provider } = context;
  const { allowNetwork, revokeNetwork } = provider;
  if (!allowNetwork || !revokeNetwork) {
    throw setupFailure(
      name,
      "Temporary network rules are unavailable for this provider",
      "SANDBOX_PROVIDER_UNAVAILABLE",
    );
  }

  let added = hosts;

  try {
    await execution.mutate(
      {
        type: "sandbox.network.allow",
        description: `Allow ${hosts.join(", ")} for sandbox ${name} during setup using ${provider.name}`,
        input: { provider: provider.name, name, hosts },
      },
      async () => {
        added = await allowNetwork.call(provider, name, hosts);
      },
    );
  } catch (error) {
    throw setupFailure(
      name,
      `Its setup hosts could not be opened: ${errorMessage(error)}`,
      error instanceof SandboxError ? error.code : "SANDBOX_NETWORK_RULE_FAILED",
    );
  }

  try {
    await run();
  } finally {
    if (added.length > 0) await closeSetupNetwork(context, name, added);
  }
}

async function closeSetupNetwork(
  context: SetupNetworkContext,
  name: string,
  hosts: string[],
): Promise<void> {
  const { execution, provider, onWarning } = context;
  try {
    await execution.mutate(
      {
        type: "sandbox.network.revoke",
        description: `Remove ${hosts.join(", ")} for sandbox ${name} after setup using ${provider.name}`,
        input: { provider: provider.name, name, hosts },
      },
      () => provider.revokeNetwork!(name, hosts),
    );
  } catch (error) {
    onWarning?.(
      `Setup network rules for sandbox ${name} may still be open (${hosts.join(", ")}): ${errorMessage(error)}`,
    );
  }
}

function setupFailure(name: string, detail: string, code: string): PostHookFailure {
  return new PostHookFailure({
    code,
    message: `Sandbox ${name} was created and is left in place. ${detail}`,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
