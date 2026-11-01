import type { ResolvedConfig, ConfigSource } from "../config/config.service";
import { parseConfigPath } from "../config/path";
import { SandboxError } from "./errors";

export function listProfiles(resolved: ResolvedConfig) {
  return Object.keys(resolved.config.sandbox?.profiles ?? {})
    .sort()
    .map((name) => describeProfile(resolved, name));
}

export function describeProfile(resolved: ResolvedConfig, name: string) {
  const profiles = resolved.config.sandbox?.profiles ?? {};
  if (!Object.hasOwn(profiles, name)) {
    throw new SandboxError(
      "SANDBOX_PROFILE_NOT_FOUND",
      `Unknown sandbox profile ${JSON.stringify(name)}.`,
    );
  }

  const profile = profiles[name]!;
  const provenance: Record<string, ConfigSource> = Object.fromEntries(
    Object.entries(resolved.provenance).filter(([path]) => {
      const parts = parseConfigPath(path);
      return parts[0] === "sandbox" && parts[1] === "profiles" && parts[2] === name;
    }),
  );
  const sources = [
    ...new Set(
      Object.values(provenance).flatMap((source) => (source.type === "file" ? [source.path] : [])),
    ),
  ].sort();
  const provider = profile.provider ?? resolved.config.sandbox?.default_provider ?? null;
  const providerSource =
    profile.provider === undefined
      ? (resolved.provenance["sandbox.default_provider"] ?? null)
      : null;

  return {
    name,
    provider,
    profile,
    sources,
    provenance,
    ...(providerSource ? { providerSource } : {}),
  };
}
