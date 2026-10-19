export const sandboxProviderNames = ["docker-sbx"] as const;

export type SandboxProviderName = (typeof sandboxProviderNames)[number];
export type CreateSandboxInput = { name: string; image?: string };

export interface SandboxProvider {
  readonly name: SandboxProviderName;

  preflight(): Promise<void>;

  create(input: CreateSandboxInput): Promise<void>;
}
