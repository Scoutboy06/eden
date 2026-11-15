import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTemporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "eden-fs-"));

  return {
    path,
    [Symbol.asyncDispose]: async () => {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
