import { formatConfigPath } from "./path";
import type { ConfigSource } from "./config.service";

export function mergeConfigLayer(
  target: Record<string, unknown>,
  layer: Record<string, unknown>,
  provenance: Record<string, ConfigSource>,
  path: string,
  prefix: string[] = [],
): void {
  for (const [key, value] of Object.entries(layer)) {
    const keys = [...prefix, key];

    if (isConfigObject(value)) {
      mergeConfigObject(target, key, value, provenance, path, keys, prefix);
      continue;
    }

    setConfigValue(target, key, value);
    clearConfigProvenance(provenance, keys);
    provenance[formatConfigPath(keys)] = { type: "file", path };
  }
}

function mergeConfigObject(
  target: Record<string, unknown>,
  key: string,
  value: Record<string, unknown>,
  provenance: Record<string, ConfigSource>,
  path: string,
  keys: string[],
  prefix: string[],
): void {
  const wasPresent = Object.hasOwn(target, key);
  const current = wasPresent ? target[key] : undefined;

  if (!isConfigObject(current)) {
    clearConfigProvenance(provenance, keys);
    setConfigValue(target, key, {});
  }

  applyProfileProvenance(value, provenance, path, keys, prefix, wasPresent);
  mergeConfigLayer(target[key] as Record<string, unknown>, value, provenance, path, keys);
}

function applyProfileProvenance(
  value: Record<string, unknown>,
  provenance: Record<string, ConfigSource>,
  path: string,
  keys: string[],
  prefix: string[],
  wasPresent: boolean,
): void {
  const isProfilePath = prefix[0] === "sandbox" && prefix[1] === "profiles" && prefix.length === 2;

  if (!isProfilePath) return;

  const profilePath = formatConfigPath(keys);
  const profileSettingCount = Object.keys(value).length;
  const isEmptyNewProfile = profileSettingCount === 0 && !wasPresent;
  const hasProfileSettings = profileSettingCount > 0;

  if (isEmptyNewProfile) {
    provenance[profilePath] = { type: "file", path };
  } else if (hasProfileSettings) {
    delete provenance[profilePath];
  }
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function omitHosts(config: Record<string, unknown>): Record<string, unknown> {
  const { hosts: _hosts, ...localConfig } = config;
  return localConfig;
}

function setConfigValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function clearConfigProvenance(provenance: Record<string, ConfigSource>, keys: string[]): void {
  const prefix = formatConfigPath(keys);

  for (const key of Object.keys(provenance)) {
    const isSamePath = key === prefix;
    const isNestedPath = key.startsWith(`${prefix}.`) || key.startsWith(`${prefix}[`);

    if (isSamePath || isNestedPath) delete provenance[key];
  }
}
