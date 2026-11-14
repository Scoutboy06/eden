import { normalize } from "node:path";

export const rootPrefix = process.platform === "win32" ? "C:" : "";

export function rootedPath(path: string): string {
  return normalize(`${rootPrefix}${path}`);
}
