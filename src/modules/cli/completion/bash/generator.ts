import type { CompletionCommand, CompletionGenerator } from "../generator";
import { choiceSets, nameCommands, valueFlags, visibleFlags, type NamedCommand } from "../model";
import { quote } from "../shell";
import { runtime } from "./runtime";

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

function renderLookup(name: string, cases: string[], fallback = "return 1"): string {
  return `_eden_bash_${name}() {
  case "$1" in
    ${cases.join("\n    ")}
    *) ${fallback} ;;
  esac
}`;
}

function renderCommand({ command, id }: NamedCommand): string {
  return `${quote(String(id))})
      options=( ${visibleFlags(command.args).map(quote).join(" ")} )
      value_options=( ${valueFlags(command.args).map(quote).join(" ")} )
      commands=( ${command.commands.map((child) => quote(child.name)).join(" ")} )
      ;;`;
}

function renderChoices({ command, id }: NamedCommand): string[] {
  return choiceSets(command.args).map(
    ({ keys, choices }) =>
      `${keys.map((key) => quote(`${id}:${key}`)).join("|")}) choices=( ${choices.map(quote).join(" ")} ) ;;`,
  );
}

function renderChildren({ id, children }: NamedCommand): string[] {
  return children.map(
    (child) => `${quote(`${id}:${child.command.name}`)}) command_id=${child.id} ;;`,
  );
}
