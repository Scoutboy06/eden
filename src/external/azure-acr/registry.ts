import { ScriptRunner } from "../../modules/script";
import { SandboxError } from "../../modules/sandbox/errors";

export type AzureCliRunner = (args: string[]) => Promise<string>;
export type AzureRegistryDependencies = { runAz?: AzureCliRunner; fetch?: typeof fetch };
export type AzureImageReference = { host: string; repository: string; tag: string };

const manifestAccept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export function isAzureRegistryHost(host: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.azurecr\.(io|cn|us)$/i.test(host);
}

export function parseAzureImageReference(reference: string): AzureImageReference {
  const slash = reference.indexOf("/");
  if (slash <= 0) throw failure(`Image ${reference} does not name an Azure registry host.`);
  const host = reference.slice(0, slash).toLowerCase();
  const rest = reference.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  const hasTag = colon > rest.lastIndexOf("/");

  return {
    host,
    repository: hasTag ? rest.slice(0, colon) : rest,
    tag: hasTag ? rest.slice(colon + 1) : "latest",
  };
}

export async function azureManifestDigest(
  image: AzureImageReference,
  dependencies: AzureRegistryDependencies = {},
): Promise<string> {
  const runAz = dependencies.runAz ?? runAzureCli;
  const request = dependencies.fetch ?? fetch;
  const refreshToken = await exposeRefreshToken(image.host, runAz);
  const accessToken = await exchangeToken(image, refreshToken, request);
  const response = await request(
    `https://${image.host}/v2/${image.repository}/manifests/${encodeURIComponent(image.tag)}`,
    { method: "HEAD", headers: { authorization: `Bearer ${accessToken}`, accept: manifestAccept } },
  ).catch((error: unknown) => {
    throw failure(`Could not reach registry ${image.host}: ${message(error)}`);
  });
  if (!response.ok)
    throw failure(
      `Registry ${image.host} returned ${response.status} for ${image.repository}:${image.tag}.`,
    );
  const digest = response.headers.get("docker-content-digest");
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest))
    throw failure("Registry returned an invalid image digest.");

  return digest;
}

export async function azureDockerLogin(
  host: string,
  runAz: AzureCliRunner = runAzureCli,
): Promise<void> {
  await runAz(["acr", "login", "--name", registryName(host), "--only-show-errors"]);
}

async function runAzureCli(args: string[]): Promise<string> {
  const result = await ScriptRunner.run("az", null, { args }).catch(() => {
    throw failure("Could not start az; install the Azure CLI and run az login.");
  });
  if (result.outcome === "cancelled") throw new SandboxError("CANCELLED", "az was cancelled.");
  if (result.outcome !== "exited" || result.exitCode !== 0) throw azureCliFailure(result.stderr);

  return result.stdout;
}

export function azureCliFailure(stderr: string): SandboxError {
  const detail = stderr.trim();
  if (/az login|AADSTS|not logged in|credentials/i.test(detail))
    return failure("Azure CLI is not logged in; run az login and retry.");

  return failure(`az failed while authenticating to the registry. ${detail}`.trim());
}

async function exposeRefreshToken(host: string, runAz: AzureCliRunner): Promise<string> {
  const output = await runAz([
    "acr",
    "login",
    "--name",
    registryName(host),
    "--expose-token",
    "--output",
    "json",
    "--only-show-errors",
  ]);
  const token = (parse(output) as { accessToken?: unknown } | undefined)?.accessToken;
  if (typeof token !== "string" || token === "")
    throw failure("az did not return a registry access token.");

  return token;
}

async function exchangeToken(
  image: AzureImageReference,
  refreshToken: string,
  request: typeof fetch,
): Promise<string> {
  const response = await request(`https://${image.host}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      service: image.host,
      scope: `repository:${image.repository}:pull`,
      refresh_token: refreshToken,
    }),
  }).catch((error: unknown) => {
    throw failure(`Could not reach registry ${image.host}: ${message(error)}`);
  });
  if (!response.ok)
    throw failure(`Registry ${image.host} rejected the Azure token (${response.status}).`);
  const token = (parse(await response.text()) as { access_token?: unknown } | undefined)
    ?.access_token;
  if (typeof token !== "string" || token === "")
    throw failure("Registry did not return a bearer token.");

  return token;
}

function registryName(host: string): string {
  return host.split(".")[0]!;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(text: string): SandboxError {
  return new SandboxError("SANDBOX_TEMPLATE_UPDATE_FAILED", text);
}
