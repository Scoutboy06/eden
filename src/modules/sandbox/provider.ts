export const sandboxProviderNames = ["docker-sbx"] as const;

export type SandboxProviderName = (typeof sandboxProviderNames)[number];
export const sandboxProviderLabels: Record<SandboxProviderName, string> = {
  "docker-sbx": "Docker Sandboxes",
};
export type SandboxSummary = {
  provider: SandboxProviderName;
  name: string;
  status: string;
};
export type CreateSandboxInput = {
  name: string;
  image?: string;
  kits?: string[];
  kitArgs?: Record<string, string | number | boolean>;
};
export type RunSandboxInput = { name: string; image?: string };

export interface SandboxProvider {
  readonly name: SandboxProviderName;

  preflight(): Promise<void>;
  readinessChecks(): readonly ReadinessCheck[];

  create(input: CreateSandboxInput): Promise<void>;
  list(): Promise<SandboxSummary[]>;
  run(name: string): Promise<number>;
  stop(name: string): Promise<void>;
}
import type { ReadinessCheck } from "./readiness";
