import type { Agent } from "../config/schema";

export const sandboxProviderNames = ["docker-sbx"] as const;

export type SandboxProviderName = (typeof sandboxProviderNames)[number];
export const sandboxProviderLabels: Record<SandboxProviderName, string> = {
  "docker-sbx": "Docker Sandboxes",
};
export type SandboxSummary = {
  provider: SandboxProviderName;
  name: string;
  status: string;
  workspace?: string;
  createdAt?: string;
  profile?: string;
};
export type CreateSandboxInput = {
  name: string;
  agent?: Agent | (string & {});
  workspace?: { mode: "none" | "clone" | "host"; path?: string };
  mounts?: Record<string, { path: string; readonly?: boolean; create?: boolean }>;
  image?: string;
  pull?: "always" | "missing" | "never";
  disk?: { root?: string; docker?: string };
  kits?: string[];
  mcpServers?: string[];
  kitArgs?: Record<string, string | number | boolean>;
};
export type AddKitInput = {
  name: string;
  kit: string;
  kitArgs?: Record<string, string | number | boolean>;
};
export type RunSandboxInput = { name: string };
export type ExecSandboxInput = {
  name: string;
  argv: string[];
  output: "capture" | "inherit";
  workdir?: string;
  tty?: boolean;
};
export type ExecSandboxResult = { exitCode: number; stdout: string; stderr: string };
export type TransferSandboxInput = {
  name: string;
  argv: string[];
  stdinFile?: string;
  stdoutFile?: string;
};
export type TransferSandboxResult = { exitCode: number; stderr: string };
export type SshAccess = { host: string; command: string[]; setupCommand: string[] };

export interface SandboxProvider {
  readonly name: SandboxProviderName;

  preflight(input: CreateSandboxInput): Promise<void>;
  readinessChecks(): readonly ReadinessCheck[];

  create(input: CreateSandboxInput): Promise<void>;
  addKit?(input: AddKitInput): Promise<void>;
  allowNetwork?(name: string, hosts: string[]): Promise<string[]>;
  revokeNetwork?(name: string, hosts: string[]): Promise<void>;
  list(): Promise<SandboxSummary[]>;
  run(name: string): Promise<number>;
  exec?(input: ExecSandboxInput): Promise<ExecSandboxResult>;
  transfer?(input: TransferSandboxInput): Promise<TransferSandboxResult>;
  sshAccess?(name: string): SshAccess;
  start?(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove?(name: string, force: boolean): Promise<void>;
}
import type { ReadinessCheck } from "./readiness";
