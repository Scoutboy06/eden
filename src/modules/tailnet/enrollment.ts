import { createAuthKey, exchangeOAuthSecret, revokeAuthKey } from "../../external/tailscale/api";
import * as credentials from "./credentials";
import type { SandboxProvider } from "../sandbox/provider";

export type TailnetEnrollment = { nodeId: string; dnsName: string };

export async function exchangeStoredCredential(
  dependencies: Parameters<typeof exchangeOAuthSecret>[1] = {},
): Promise<string> {
  const credential = await credentials.get();
  if (!credential) throw new Error("No Tailscale credential is stored.");
  return exchangeOAuthSecret(credential, dependencies);
}

export async function mintOneTimeKey(
  accessToken: string,
  tag: string,
  dependencies: Parameters<typeof createAuthKey>[2] = {},
): Promise<{ id: string; key: string }> {
  return createAuthKey(accessToken, tag, dependencies);
}

export async function revokeOneTimeKey(
  accessToken: string,
  keyId: string,
  dependencies: Parameters<typeof revokeAuthKey>[2] = {},
): Promise<void> {
  return revokeAuthKey(accessToken, keyId, dependencies);
}

export async function enrollSandbox(
  provider: SandboxProvider,
  name: string,
  authKey: string,
): Promise<TailnetEnrollment> {
  if (!provider.exec) throw new Error("Sandbox execution is unavailable for this provider.");

  const readiness = await provider.exec({
    name,
    argv: ["/usr/local/bin/tailscale", "status", "--json"],
    output: "capture",
  });
  if (readiness.exitCode !== 0)
    throw new Error(
      "Tailscale is not ready in this sandbox. Install and start the eden-tailscale kit before enrollment.",
    );

  const result = await provider.exec({
    name,
    argv: ["sh", "-c", enrollmentScript],
    output: "capture",
    stdin: authKey,
  });
  if (result.exitCode !== 0)
    throw new Error(`Tailscale enrollment failed: ${result.stderr.trim()}`);

  const status = JSON.parse(result.stdout) as { Self?: { ID?: string; DNSName?: string } };
  const nodeId = status.Self?.ID;
  const dnsName = status.Self?.DNSName;
  if (typeof nodeId !== "string" || typeof dnsName !== "string")
    throw new Error("Tailscale returned an invalid status response after enrollment.");

  return { nodeId, dnsName };
}

const enrollmentScript = `set -eu
umask 077
key_file=$(mktemp)
trap 'rm -f "$key_file"' EXIT HUP INT TERM
cat > "$key_file"
/usr/local/bin/tailscale up --auth-key="file:$key_file" --ssh --accept-routes=false --accept-dns=false
/usr/local/bin/tailscale status --json`;
