import { ConfigError, type ConfigIssue } from "../config/errors";

export type ErrorDescription = { code: string; message: string; issues?: readonly ConfigIssue[] };

export function describeError(error: unknown, fallbackCode: string): ErrorDescription {
  if (error instanceof AggregateError) {
    const failures = error.errors.map((cause) => describeError(cause, fallbackCode));
    const first = failures[0];

    return failures.length === 1 && first
      ? first
      : {
          code: fallbackCode,
          message: failures.map((failure) => failure.message).join("\n") || error.message,
        };
  }

  return {
    code: errorCode(error) ?? fallbackCode,
    message: errorMessage(error),
    ...(error instanceof ConfigError && error.code === "CONFIG_SCHEMA_INVALID"
      ? { issues: error.issues }
      : {}),
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
