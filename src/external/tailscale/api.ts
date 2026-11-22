import { SandboxError } from "../../modules/sandbox/errors";

export type TailscaleDependencies = { fetch?: typeof fetch; baseUrl?: string };

export type TailscaleAuthKey = { id: string; key: string };

export type TailscaleAuthentication = "authenticated" | "rejected" | "unreachable";

export class TailscaleApiError extends SandboxError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super("SANDBOX_TEMPLATE_UPDATE_FAILED", message);
  }
}

export async function checkAuthentication(
  accessToken: string,
  dependencies: TailscaleDependencies = {},
): Promise<TailscaleAuthentication> {
  try {
    const response = await request(dependencies, "/api/v2/tailnet/-/keys", {
      method: "GET",
      headers: bearer(accessToken),
    });
    return response.ok
      ? "authenticated"
      : response.status === 401 || response.status === 403
        ? "rejected"
        : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function exchangeOAuthSecret(
  clientSecret: string,
  dependencies: TailscaleDependencies = {},
): Promise<string> {
  const response = await request(dependencies, "/api/v2/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientSecret }),
  });
  const body = await responseJson(response, "Tailscale rejected the OAuth client secret");
  const token = body?.access_token;
  if (typeof token !== "string" || token === "")
    throw failure("Tailscale returned no access token.");

  return token;
}

export async function createAuthKey(
  accessToken: string,
  tag: string,
  dependencies: TailscaleDependencies = {},
): Promise<TailscaleAuthKey> {
  const response = await request(dependencies, "/api/v2/tailnet/-/keys", {
    method: "POST",
    headers: bearer(accessToken),
    body: JSON.stringify({
      capabilities: {
        devices: {
          create: { reusable: false, ephemeral: false, preauthorized: true, tags: [tag] },
        },
      },
      expirySeconds: 600,
    }),
  });
  const body = await responseJson(response, "Tailscale rejected the auth key request.");
  const key = body?.key;
  const id = body?.id;
  if (typeof key !== "string" || typeof id !== "string")
    throw failure("Tailscale returned an invalid auth key.");

  return { id, key };
}

export async function revokeAuthKey(
  accessToken: string,
  keyId: string,
  dependencies: TailscaleDependencies = {},
): Promise<void> {
  const response = await request(
    dependencies,
    `/api/v2/tailnet/-/keys/${encodeURIComponent(keyId)}`,
    {
      method: "DELETE",
      headers: bearer(accessToken),
    },
  );
  await responseJson(response, "Tailscale rejected the auth key revocation.", true);
}

export async function deleteDevice(
  accessToken: string,
  deviceId: string,
  dependencies: TailscaleDependencies = {},
): Promise<void> {
  const response = await request(dependencies, `/api/v2/device/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: bearer(accessToken),
  });
  await responseJson(response, "Tailscale rejected the device deletion.", true, true);
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function request(
  dependencies: TailscaleDependencies,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const fetcher = dependencies.fetch ?? fetch;
  return fetcher(`${dependencies.baseUrl ?? "https://api.tailscale.com"}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15000),
  }).catch(() => {
    throw failure("Could not reach the Tailscale API.");
  });
}

async function responseJson(
  response: Response,
  error: string,
  emptySuccess = false,
  notFoundSuccess = false,
): Promise<Record<string, unknown> | undefined> {
  if (notFoundSuccess && response.status === 404) return undefined;
  if (!response.ok) throw new TailscaleApiError(`${error} (${response.status}).`, response.status);
  if (emptySuccess || response.status === 204) return undefined;
  return response.json().catch(() => undefined) as Promise<Record<string, unknown> | undefined>;
}

function failure(message: string): TailscaleApiError {
  return new TailscaleApiError(message);
}
