import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kitDirectory = dirname(fileURLToPath(import.meta.url));

export function tailscaleKitPath(): string {
  return resolve(kitDirectory);
}
