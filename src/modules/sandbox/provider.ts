export const sandboxProviderNames = ["docker-sbx"] as const;

export type SandboxProviderName = (typeof sandboxProviderNames)[number];
export const sandboxProviderLabels: Record<SandboxProviderName, string> = {
  "docker-sbx": "Docker Sandboxes",
};
export type CreateSandboxInput = { name: string; image?: string };

export interface SandboxProvider {
  readonly name: SandboxProviderName;

  preflight(): Promise<void>;
  readinessChecks(): readonly ReadinessCheck[];

  create(input: CreateSandboxInput): Promise<void>;
  requireExisting(name: string): Promise<void>;
  run(name: string): Promise<number>;
}
import type { ReadinessCheck } from "./readiness";
