import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SandboxProfile } from "../config/schema";
import type { CreateSandboxInput, SandboxProviderName } from "./provider";

export function resolveCreateInput(
  input: CreateSandboxInput,
  profile?: SandboxProfile,
): CreateSandboxInput {
  const workspace = input.workspace ?? profile?.workspace;
  const mounts = input.mounts ?? profile?.mounts;
  const agent = input.agent ?? profile?.agent;
  const pull = input.pull ?? profile?.pull;
  const disk = input.disk ?? profile?.disk;
  const kits = input.kits ?? profile?.kits;
  const mcpServers = input.mcpServers ?? profile?.mcp_servers;
  const kitArgs = input.kitArgs ?? profile?.kit_args;
  const resolvedKits = kits?.map(resolveKitReference);
  const image = input.image ?? profile?.template;

  const settings = {
    workspace,
    mounts,
    agent,
    pull,
    disk,
    kits: resolvedKits,
    mcpServers,
    kitArgs,
  };
  const definedEntries = Object.entries(settings).filter(([, value]) => value !== undefined);
  const definedSettings = Object.fromEntries(definedEntries);

  return { ...input, image, ...definedSettings };
}

export function workspaceWarnings(input: CreateSandboxInput): string[] {
  const usesHostWorkspace = input.workspace?.mode === "host";
  const hasWritableMount = Object.values(input.mounts ?? {}).some((mount) => !mount.readonly);

  if (usesHostWorkspace || hasWritableMount) {
    return [
      "Host workspace or mount is writable: the agent can change hooks, Git configuration, and build output that may run on the host later.",
    ];
  }
  return [];
}

export function createAuditInput(
  provider: SandboxProviderName,
  resolved: CreateSandboxInput,
  warnings: string[],
  profile: (SandboxProfile & { name: string }) | undefined,
) {
  const auditInput: Record<string, unknown> = { provider, ...resolved };
  if (warnings.length > 0) {
    auditInput.warnings = warnings;
  }
  if (profile !== undefined) {
    auditInput.profile = profile.name;
  }
  return auditInput;
}

export function describeCreation(provider: string, input: CreateSandboxInput): string {
  const descriptions = [`Create sandbox ${input.name} using ${provider}`];
  if (input.workspace?.path) {
    descriptions.push(` with ${input.workspace.mode} workspace ${input.workspace.path}`);
  }
  if (input.kits?.length) {
    const kits = input.kits.join(", ");
    descriptions.push(`\n  Kits: ${kits}`);
  }
  for (const [name, mount] of Object.entries(input.mounts ?? {})) {
    const access = mount.readonly ? "read-only" : "writable";
    descriptions.push(`\n  Mount ${name}: ${mount.path} (${access})`);
  }
  for (const [name, value] of Object.entries(input.kitArgs ?? {})) {
    const displayValue = String(value);
    descriptions.push(`\n  Kit argument ${name}: ${displayValue}`);
  }
  if (input.mcpServers?.length) {
    const servers = input.mcpServers.join(", ");
    descriptions.push(`\n  Static MCP servers: ${servers}`);
  }
  if (input.pull) {
    descriptions.push(`\n  Pull: ${input.pull}`);
  }
  if (input.disk) {
    const settings = Object.entries(input.disk).map(([key, value]) => `${key}=${value}`);
    const disk = settings.join(", ");
    descriptions.push(`\n  Disk: ${disk}`);
  }

  return descriptions.join("");
}

function expandWorkspacePath(path: string): string {
  if (path === "~") {
    return homedir();
  }
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
