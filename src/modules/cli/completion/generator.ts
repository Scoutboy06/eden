import type { Args, Commandable } from "gunshi";
import { getCommandSubCommands, kebabnize, resolveLazyCommand } from "gunshi/utils";

export interface CompletionCommand {
  name: string;
  description?: string;
  args: Args;
  commands: CompletionCommand[];
}

export interface CompletionGenerator {
  generate(command: CompletionCommand): string;
}

export async function completionCommand(
  name: string,
  command: Commandable,
  globals: Args,
): Promise<CompletionCommand> {
  const resolved = await resolveLazyCommand(command, name, false);
  return {
    name,
    description: resolved.description,
    args: Object.fromEntries(
      Object.entries({ ...globals, ...resolved.args }).map(([key, arg]) => [
        resolved.toKebab ? kebabnize(key) : key,
        arg,
      ]),
    ),
    commands: await Promise.all(
      [...(getCommandSubCommands(resolved) ?? [])]
        .filter(([, child]) => !child.internal)
        .map(([key, child]) => completionCommand(key, child, globals)),
    ),
  };
}
