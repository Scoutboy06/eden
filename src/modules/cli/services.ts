import type { Execution } from "../execution";
import { FilesystemService } from "../fs";
import { createConfigService } from "../config/config.service";
import { WorktreeService } from "../worktree/worktree.service";
import { HookService } from "../hook/hook.service";
import type { EdenExtensions } from "./options";
import { CommandOutput } from "./output";

export function createCommandServices(options: EdenExtensions, execution: Execution) {
  const onStderr = options.json ? undefined : streamStderr;
  const hooks = new HookService(execution, { onStderr });
  const output = new CommandOutput(options, execution.operations);
  let fs: FilesystemService | undefined;
  let worktree: WorktreeService | undefined;
  let config: ReturnType<typeof createConfigService> | undefined;

  return {
    output,
    get config() {
      return (config ??= createConfigService());
    },
    get worktree() {
      output.includeHooks(hooks.records);

      return (worktree ??= new WorktreeService(execution, createConfigService(), hooks));
    },
    get fs() {
      return (fs ??= new FilesystemService(execution));
    },
  };
}

function streamStderr(text: string): void {
  process.stderr.write(text);
}

export type CommandServices = ReturnType<typeof createCommandServices>;
