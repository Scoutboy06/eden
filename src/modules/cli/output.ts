import type { Operation } from "../execution";
import type { ExecutionResult } from "../execution/types";
import { HookFailure, type HookExecution } from "../hook/hook.service";
import { describeError } from "./error-description";

type Presentation = { data: Record<string, unknown>; human: () => string | Promise<string> };

export class CommandOutput {
  private rawWritten = false;
  private presentation: Presentation | undefined;
  private hooks: HookExecution[] | undefined;

  constructor(
    private readonly options: { json: boolean },
    private readonly operations: readonly Operation[],
  ) {}

  write(value: Presentation): void {
    this.presentation = value;
  }

  raw(text: string): void {
    this.rawWritten = true;
    process.stdout.write(text);
  }

  includeHooks(records: HookExecution[]): void {
    this.hooks = records;
  }

  async finish(result: ExecutionResult<unknown>): Promise<void> {
    const details = this.hooks ? { hooks: this.hooks } : {};

    if (!result.ok) {
      await writeFailure(result, this.options.json, details);
      return;
    }

    if (this.rawWritten) return;
    if ((result.dryRun || !this.presentation) && this.operations.length > 0) {
      await printOperations(this.operations, { json: this.options.json, ...result });
      return;
    }

    const value = this.presentation ?? { data: {}, human: () => "" };

    await writeOutput(
      { json: this.options.json, destination: "stdout" },
      {
        data: { ...value.data, ...details, ok: result.ok, dryRun: result.dryRun },
        human: value.human,
      },
    );
  }
}

export async function writeOutput(
  options: { json: boolean; destination: "stdout" | "stderr" },
  presentation: { data: unknown; human: () => string | Promise<string> },
): Promise<void> {
  const text = options.json ? JSON.stringify(presentation.data) : await presentation.human();

  if (text) process[options.destination].write(`${text}\n`);
}

export function printOperations(
  operations: readonly Operation[],
  options: { json: boolean; ok: true; dryRun: boolean },
): Promise<void> {
  return writeOutput(
    { json: options.json, destination: "stdout" },
    {
      data: { ok: options.ok, dryRun: options.dryRun, operations },
      human: () =>
        operations
          .map((op) => `${options.dryRun ? "[dry-run]" : "[execute]"} ${op.description}`)
          .join("\n"),
    },
  );
}

async function writeFailure(
  result: Extract<ExecutionResult<unknown>, { ok: false }>,
  json: boolean,
  details: { hooks?: HookExecution[] },
): Promise<void> {
  const error =
    result.error instanceof HookFailure
      ? result.error.detail
      : describeError(result.error, "COMMAND_FAILED");
  process.exitCode = error.code === "CANCELLED" ? 130 : 1;

  await writeOutput(
    { json, destination: json ? "stdout" : "stderr" },
    {
      data: { ok: result.ok, dryRun: result.dryRun, error, ...details },
      human: () => failureMessage(error.message, details.hooks ?? []),
    },
  );
}

function failureMessage(message: string, hooks: HookExecution[]): string {
  for (const hook of hooks) {
    if ("result" in hook.input)
      return `${message}\nWorktree was created at ${hook.input.result.path}`;
  }

  return message;
}
