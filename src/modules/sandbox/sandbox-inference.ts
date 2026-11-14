import { deriveSandboxName, pathKey } from "./sandbox-checkout";
import { SandboxError } from "./errors";
import type { SandboxProviderName, SandboxSummary } from "./provider";

export type InferredSandbox = {
  name: string;
  source: "workspace" | "folder";
  checkout: string;
};

export async function inferSandbox(
  sandboxes: readonly SandboxSummary[],
  checkout: string,
  provider: SandboxProviderName,
): Promise<InferredSandbox> {
  const checkoutKey = await pathKey(checkout);
  const workspaceMatches: string[] = [];

  for (const sandbox of sandboxes) {
    if (sandbox.workspace !== undefined && (await pathKey(sandbox.workspace)) === checkoutKey) {
      workspaceMatches.push(sandbox.name);
    }
  }

  if (workspaceMatches.length > 1) {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      `Several ${provider} sandboxes use the checkout ${checkout}: ${workspaceMatches.join(", ")}. Pass --name.`,
    );
  }
  if (workspaceMatches.length === 1) {
    return { name: workspaceMatches[0]!, source: "workspace", checkout };
  }

  const derived = deriveSandboxName(checkout);
  const sameName = sandboxes.find((sandbox) => sandbox.name === derived);
  if (sameName !== undefined && sameName.workspace === undefined) {
    return { name: derived, source: "folder", checkout };
  }

  throw new SandboxError(
    "SANDBOX_NOT_FOUND",
    `No sandbox found for the checkout ${checkout} using ${provider} (looked for a matching workspace and a workspace-less sandbox named ${derived}). Pass --name or create one with eden sbx create. If it belongs to another provider, specify --provider.`,
  );
}
