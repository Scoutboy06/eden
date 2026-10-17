import { plugin, type CommandContext } from "gunshi";
import { renderUsage, renderValidationErrors } from "gunshi/renderer";
import { writeOutput } from "./output";
import { requestsFlag } from "./options";
import { describeError, type ErrorDescription } from "./error-description";

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

export async function withCliErrors(argv: string[], run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    await reportError(error, argv);
  }
}

async function reportError(error: unknown, argv: string[]): Promise<void> {
  const { failure, context } = normalizeError(error);
  const json = context ? context.values.json === true : requestsFlag(argv, "json");
  const dryRun = context ? context.values["dry-run"] === true : requestsFlag(argv, "dry-run");
  await writeOutput(
    {
      json,
      destination: json ? "stdout" : "stderr",
    },
    {
      data: {
        ok: false,
        dryRun,
        error: failure.error,
      },
      human: () => renderHuman(failure),
    },
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
