import { createExecution } from "../execution";
import { FilesystemService } from "../fs";
import type { EdenExtensions } from "./options";
import { printOperations } from "./output";

export function createCommandServices(options: EdenExtensions) {
  const execution = createExecution({ dryRun: options.dryRun });
  let fs: FilesystemService | undefined;

  return {
    get fs() {
      return (fs ??= new FilesystemService(execution));
    },

    output: {
      printOperations: () => printOperations(execution.operations, options),
    },
  };
}

export type CommandServices = ReturnType<typeof createCommandServices>;
