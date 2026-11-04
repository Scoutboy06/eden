import { runCli, type CliSubCommands } from "../../parser";
import { parserCommands } from "../fixtures/parser-commands";
import { captureOutput } from "./output";

export async function parseCommands(commands: CliSubCommands, ...argv: string[]) {
  const previousExitCode = process.exitCode;

  try {
    process.exitCode = 0;
    const output = await captureOutput(() => runCli(commands, argv));
    return { exitCode: Number(process.exitCode), ...output };
  } finally {
    process.exitCode = previousExitCode ?? 0;
  }
}

export function parseFixture(...argv: string[]) {
  return parseCommands(parserCommands, ...argv);
}
