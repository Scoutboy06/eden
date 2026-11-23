import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTemporaryDirectory() {
  const createdPath = await mkdtemp(join(tmpdir(), "eden-fs-"));
  const path = await realpath(createdPath);

  return {
    path,
    [Symbol.asyncDispose]: async () => {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
