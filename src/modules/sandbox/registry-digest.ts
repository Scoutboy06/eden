import type { SandboxProfile } from "../config/schema";
import {
  azureDockerLogin,
  azureManifestDigest,
  isAzureRegistryHost,
  parseAzureImageReference,
  type AzureRegistryDependencies,
} from "../../external/azure-acr/registry";
import { registryDigest } from "../../external/docker-sbx/template-commands";

export type RegistryAuth = NonNullable<SandboxProfile["registry_auth"]>;

export function usesAzureAuth(reference: string, auth: RegistryAuth = "auto"): boolean {
  if (auth === "docker") return false;
  if (auth === "azure") return true;
  const slash = reference.indexOf("/");

  return slash > 0 && isAzureRegistryHost(reference.slice(0, slash));
}

export async function resolveRegistryDigest(
  reference: string,
  auth: RegistryAuth = "auto",
  dependencies?: AzureRegistryDependencies,
): Promise<string> {
  if (!usesAzureAuth(reference, auth)) return registryDigest(reference);

  return azureManifestDigest(parseAzureImageReference(reference), dependencies);
}

export async function prepareRegistryPull(
  reference: string,
  auth: RegistryAuth = "auto",
  runAz?: AzureRegistryDependencies["runAz"],
): Promise<void> {
  if (!usesAzureAuth(reference, auth)) return;
  await azureDockerLogin(parseAzureImageReference(reference).host, runAz);
}
