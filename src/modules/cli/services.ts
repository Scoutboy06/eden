import { createExecution } from "../execution";
import { FilesystemService } from "../fs";
import { createConfigService } from "../config/config.service";
import { WorktreeService } from "../worktree/worktree.service";
import type { EdenExtensions } from "./options";
import { printOperations, writeOutput } from "./output";

export function createCommandServices(options: EdenExtensions) {
  const execution = createExecution({ dryRun: options.dryRun });
  let fs: FilesystemService | undefined;
  let worktree: WorktreeService | undefined;

  return {
    get worktree() {
      return (worktree ??= new WorktreeService(execution, createConfigService()));
    },
    get fs() {
      return (fs ??= new FilesystemService(execution));
    },

    output: {
      write: (presentation: Parameters<typeof writeOutput>[1]) =>
        writeOutput({ json: options.json, destination: "stdout" }, presentation),
      printOperations: () => printOperations(execution.operations, options),
    },
  };
}

export type CommandServices = ReturnType<typeof createCommandServices>;
