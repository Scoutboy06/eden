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
  const args = Object.fromEntries(
    Object.entries({ ...globals, ...resolved.args }).map(([key, arg]) => {
      const visibleKey = resolved.toKebab ? kebabnize(key) : key;
      return [visibleKey, arg];
    }),
  );
  const commandEntries = [...(getCommandSubCommands(resolved) ?? [])];
  const visibleCommands = commandEntries.filter(([, child]) => !child.internal);
  const commands = await Promise.all(
    visibleCommands.map(([key, child]) => completionCommand(key, child, globals)),
  );

  return {
    name,
    description: resolved.description,
    args,
    commands,
  };
}
