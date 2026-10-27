export type SandboxErrorCode =
  | "SANDBOX_INVALID_INPUT"
  | "SANDBOX_PROVIDER_UNAVAILABLE"
  | "SANDBOX_AUTH_REQUIRED"
  | "SANDBOX_NETWORK_POLICY_REQUIRED"
  | "SANDBOX_NOT_FOUND"
  | "SANDBOX_LOOKUP_FAILED"
  | "SANDBOX_CREATE_FAILED"
  | "SANDBOX_ALREADY_EXISTS"
  | "SANDBOX_PREFLIGHT_FAILED"
  | "CANCELLED";

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}
