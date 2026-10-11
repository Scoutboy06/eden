import { plugin, type CommandContext } from "gunshi";
import { renderValidationErrors } from "gunshi/renderer";

type Failure = { code: string; message: string };

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
  process.stderr.write(`${await renderError(error)}\n`);
  process.exitCode = 1;
}

async function renderError(error: unknown): Promise<string> {
  if (!(error instanceof CommandFailure)) return describeError(error, "COMMAND_FAILED").message;

  const { cause, context } = error;
  const failure = describeError(
    cause,
    cause === context.validationError ? "VALIDATION_ERROR" : "COMMAND_FAILED",
  );
  if (context.values.json === true) return JSON.stringify({ error: failure });
  if (cause === context.validationError && cause instanceof AggregateError) {
    return renderValidationErrors(context, cause);
  }
  return failure.message;
}

function describeError(error: unknown, fallbackCode: string): Failure {
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
