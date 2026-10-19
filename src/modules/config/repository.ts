import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function findRepositoryPath(cwd: string): Promise<string | undefined> {
  let path = resolve(cwd);

  while (true) {
    const marker = await stat(join(path, ".git")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;

      throw error;
    });

    if (marker?.isDirectory() || marker?.isFile()) return path;

    const parent = dirname(path);
    if (parent === path) return undefined;

    path = parent;
  }
}
