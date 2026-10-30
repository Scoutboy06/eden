import type { Args, ArgSchema } from "gunshi";
import type { CompletionCommand } from "./generator";

export interface NamedCommand {
  command: CompletionCommand;
  id: number;
  children: NamedCommand[];
}

export interface ChoiceSet {
  keys: string[];
  choices: string[];
}

export function nameCommands(root: CompletionCommand): NamedCommand[] {
  const commands: NamedCommand[] = [];
  function visit(command: CompletionCommand): NamedCommand {
    const named = { command, id: commands.length, children: [] as NamedCommand[] };
    commands.push(named);
    named.children = command.commands.map(visit);
    return named;
  }
  visit(root);
  return commands;
}

export function visibleFlags(args: Args): string[] {
  return optionEntries(args)
    .filter(([, argument]) => !argument.hidden)
    .flatMap(optionFlags);
}

export function valueFlags(args: Args): string[] {
  return optionEntries(args)
    .filter(([, argument]) => argument.type !== "boolean")
    .flatMap(optionFlags);
}

export function choiceSets(args: Args): ChoiceSet[] {
  let position = 0;
  return Object.entries(args).flatMap(([name, argument]) => {
    const keys =
      argument.type === "positional" ? [String(position++)] : optionFlags([name, argument]);
    if (argument.hidden || !argument.choices) return [];

    return { keys, choices: argument.choices as string[] };
  });
}

function optionEntries(args: Args): [string, ArgSchema][] {
  return Object.entries(args).filter(([, argument]) => argument.type !== "positional");
}

function optionFlags([name, argument]: [string, ArgSchema]): string[] {
  return [`--${name}`, ...(argument.short ? [`-${argument.short}`] : [])];
}
