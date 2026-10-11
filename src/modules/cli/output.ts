import type { Operation } from "../execution";

export function printOperations(
  operations: readonly Operation[],
  options: { json: boolean; dryRun: boolean },
) {
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: options.dryRun,
          operations,
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const op of operations) {
    console.log(`${options.dryRun ? "[dry-run]" : "[execute]"} ` + op.description);
  }
}
