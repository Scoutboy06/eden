import type { Execution, Operation } from "./types";

export function createExecution(options: { dryRun: boolean }): Execution {
  const operations: Operation[] = [];

  return {
    dryRun: options.dryRun,
    operations,

    async mutate(operation, action) {
      operations.push(operation);

      if (!options.dryRun) {
        await action();
      }
    },
  };
}
