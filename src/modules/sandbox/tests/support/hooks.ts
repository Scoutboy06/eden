import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Execution } from "../../../execution";
import { HookService } from "../../../hook/hook.service";

export function createIsolatedHooks(execution: Execution): HookService {
  return new HookService(execution, {
    directory: join(tmpdir(), `eden-test-no-hooks-${randomUUID()}`),
  });
}
