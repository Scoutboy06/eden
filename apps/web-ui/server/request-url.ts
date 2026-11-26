import type { IncomingMessage } from "node:http";

export function requestUrl(request: IncomingMessage & { originalUrl?: string }): URL {
  return new URL(request.originalUrl ?? request.url ?? "/", "http://eden.local");
}
