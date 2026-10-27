import type { Args, ArgSchema } from "gunshi";
import type { CompletionCommand, CompletionGenerator } from "../generator";
import { quote } from "../shell";
import { runtime } from "./runtime";

interface NamedCommand {
  command: CompletionCommand;
  id: number;
  children: NamedCommand[];
}

export class BashCompletionGenerator implements CompletionGenerator {
  generate(command: CompletionCommand): string {
    const commands = nameCommands(command);

    return [
      renderLookup("load_command", commands.map(renderCommand)),
      renderLookup("load_choices", commands.flatMap(renderChoices), "choices=()"),
      renderLookup("enter_command", commands.flatMap(renderChildren)),
      runtime,
      `complete -o noquote -F _eden_bash_complete -- ${quote(command.name)}`,
      "",
    ].join("\n\n");
  }
}

function nameCommands(root: CompletionCommand): NamedCommand[] {
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

function renderLookup(name: string, cases: string[], fallback = "return 1"): string {
  return `_eden_bash_${name}() {
  case "$1" in
    ${cases.join("\n    ")}
    *) ${fallback} ;;
  esac
}`;
}

function renderCommand({ command, id }: NamedCommand): string {
  const options = optionEntries(command.args);
  const visibleFlags = options.filter(([, argument]) => !argument.hidden).flatMap(optionFlags);
  const valueFlags = options
    .filter(([, argument]) => argument.type !== "boolean")
    .flatMap(optionFlags);

  return `${quote(String(id))})
      options=( ${visibleFlags.map(quote).join(" ")} )
      value_options=( ${valueFlags.map(quote).join(" ")} )
      commands=( ${command.commands.map((child) => quote(child.name)).join(" ")} )
      ;;`;
}

function renderChoices({ command, id }: NamedCommand): string[] {
  let position = 0;
  return Object.entries(command.args).flatMap(([name, argument]) => {
    const keys =
      argument.type === "positional" ? [String(position++)] : optionFlags([name, argument]);
    if (argument.hidden || !argument.choices) return [];

    return `${keys.map((key) => quote(`${id}:${key}`)).join("|")}) choices=( ${argument.choices.map(quote).join(" ")} ) ;;`;
  });
}

function renderChildren({ id, children }: NamedCommand): string[] {
  return children.map(
    (child) => `${quote(`${id}:${child.command.name}`)}) command_id=${child.id} ;;`,
  );
}

function optionEntries(args: Args): [string, ArgSchema][] {
  return Object.entries(args).filter(([, argument]) => argument.type !== "positional");
}

function optionFlags([name, argument]: [string, ArgSchema]): string[] {
  return [`--${name}`, ...(argument.short ? [`-${argument.short}`] : [])];
}
