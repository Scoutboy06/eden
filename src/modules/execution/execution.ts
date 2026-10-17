import type { Execution, ExecutionResult, Operation } from "./types";

export function createExecution(options: { dryRun: boolean }): Execution {
  const operations: Operation[] = [];

  return {
    dryRun: options.dryRun,
    operations,

    async run<T>(action: () => Promise<T>): Promise<ExecutionResult<T>> {
      try {
        return { ok: true, dryRun: options.dryRun, data: await action() };
      } catch (error) {
        return { ok: false, dryRun: options.dryRun, error };
      }
    },

    async mutate(operation, action) {
      operations.push(operation);

      if (!options.dryRun) {
        await action();
      }
    },
  };
}
