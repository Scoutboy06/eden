import { cli, define } from "gunshi";
import { captureValidationError, commandErrors, withCliErrors } from "./errors";
import { edenOptions } from "./options";

const entry = define({
  name: "eden",
  description: "EDEN Development Environment",
});

export type CliSubCommands = NonNullable<Parameters<typeof cli>[2]>["subCommands"];

export async function runCli(commands: CliSubCommands, argv = process.argv.slice(2)) {
  return withCliErrors(argv, () =>
    cli(argv, entry, {
      name: "eden",
      version: "0.1.0",
      renderHeader: null,
      renderValidationErrors: captureValidationError,
      subCommands: commands,
      plugins: [edenOptions, commandErrors],
    }),
  );
}
