import { plugin, type CommandContext } from "gunshi";
import { renderUsage, renderValidationErrors } from "gunshi/renderer";
import { writeOutput } from "./output";

type ErrorDescription = { code: string; message: string };
type ExecutionFailure = {
  kind: "execution";
  error: ErrorDescription;
};
type ValidationFailure = {
  kind: "validation";
  error: ErrorDescription;
  context: Readonly<CommandContext>;
  cause: AggregateError;
};
type Failure = ExecutionFailure | ValidationFailure;
type NormalizedError = { failure: Failure; context?: Readonly<CommandContext> };

class CommandFailure extends Error {
  constructor(
    cause: unknown,
    readonly context: Readonly<CommandContext>,
  ) {
    super("CLI command failed", { cause });
  }
}

export const commandErrors = plugin({
  id: "eden:errors",
  setup(ctx) {
    ctx.decorateCommand((run) => async (context) => {
      try {
        return await run(context);
      } catch (error) {
        throw new CommandFailure(error, context);
      }
    });
  },
});

// Gunshi renders validation errors before throwing them. Throwing here avoids
// its stdout logging and preserves the context for the outer error handler.
export async function captureValidationError(
  context: Readonly<CommandContext>,
  error: AggregateError,
): Promise<string> {
  throw new CommandFailure(error, context);
}

export async function reportError(error: unknown): Promise<void> {
  const { failure, context } = normalizeError(error);
  await writeOutput(
    { json: context?.values.json === true, destination: "stderr" },
    { data: { error: failure.error }, human: () => renderHuman(failure) },
  );
  process.exitCode = 1;
}

function normalizeError(error: unknown): NormalizedError {
  if (!(error instanceof CommandFailure)) {
    return { failure: { kind: "execution", error: describeError(error, "COMMAND_FAILED") } };
  }

  const { context, cause } = error;
  if (cause === context.validationError && cause instanceof AggregateError) {
    return {
      context,
      failure: {
        kind: "validation",
        error: describeError(cause, "VALIDATION_ERROR"),
        context,
        cause,
      },
    };
  }

  return { context, failure: { kind: "execution", error: describeError(cause, "COMMAND_FAILED") } };
}

function renderHuman(failure: Failure): string | Promise<string> {
  switch (failure.kind) {
    case "validation":
      return renderHumanValidation(failure);
    case "execution":
      return renderHumanExecution(failure);
  }
}

async function renderHumanValidation({ context, cause }: ValidationFailure): Promise<string> {
  return (await Promise.all([renderValidationErrors(context, cause), renderUsage(context)])).join(
    "\n\n",
  );
}

function renderHumanExecution({ error }: ExecutionFailure): string {
  return error.message;
}

function describeError(error: unknown, fallbackCode: string): ErrorDescription {
  if (error instanceof AggregateError) {
    const failures = error.errors.map((cause) => describeError(cause, fallbackCode));
    const first = failures[0];
    return failures.length === 1 && first
      ? first
      : {
          code: fallbackCode,
          message: failures.map((failure) => failure.message).join("\n") || error.message,
        };
  }

  return { code: errorCode(error) ?? fallbackCode, message: errorMessage(error) };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
