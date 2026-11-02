export class ScmError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScmError";
  }
}

export async function providerRequest<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ScmError) throw error;

    const status = responseStatus(error);
    if (status === 429 || rateLimited(error))
      throw new ScmError(
        "SCM_RATE_LIMITED",
        "The provider rate limit was exceeded. Try again later.",
      );
    const [code, message] = failures[status ?? 0] ?? [
      "SCM_REQUEST_FAILED",
      "The provider request failed. Check connectivity and try again.",
    ];
    throw new ScmError(code, message);
  }
}

const failures: Record<number, [string, string]> = {
  400: ["SCM_INVALID_REQUEST", "The provider rejected the request parameters."],
  401: ["SCM_AUTHENTICATION_FAILED", "Provider authentication is required or was rejected."],
  403: ["SCM_ACCESS_DENIED", "The provider denied access to this operation."],
  404: ["SCM_NOT_FOUND", "The requested resource was not found or is not accessible."],
  422: ["SCM_INVALID_REQUEST", "The provider rejected the request parameters."],
};

function rateLimited(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("response" in error)) return false;
  const response = error.response as { headers?: Record<string, string> } | undefined;

  return (
    response?.headers?.["x-ratelimit-remaining"] === "0" ||
    response?.headers?.["retry-after"] !== undefined
  );
}

export function invalidResponse(): never {
  throw new ScmError(
    "SCM_INVALID_RESPONSE",
    "The provider returned an invalid or unsupported response.",
  );
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return;
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
}
