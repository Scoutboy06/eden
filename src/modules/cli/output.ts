import type { Operation } from "../execution";

export async function writeOutput(
  options: { json: boolean; destination: "stdout" | "stderr" },
  presentation: { data: unknown; human: () => string | Promise<string> },
): Promise<void> {
  const text = options.json ? JSON.stringify(presentation.data) : await presentation.human();

  if (text) process[options.destination].write(`${text}\n`);
}

export function printOperations(
  operations: readonly Operation[],
  options: { json: boolean; dryRun: boolean },
): Promise<void> {
  return writeOutput(
    { json: options.json, destination: "stdout" },
    {
      data: { dryRun: options.dryRun, operations },
      human: () =>
        operations
          .map((op) => `${options.dryRun ? "[dry-run]" : "[execute]"} ${op.description}`)
          .join("\n"),
    },
  );
}
