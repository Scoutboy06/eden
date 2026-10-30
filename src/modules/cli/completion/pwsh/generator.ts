import type { CompletionCommand, CompletionGenerator } from "../generator";
import { choiceSets, nameCommands, valueFlags, visibleFlags, type NamedCommand } from "../model";
import { quotePowerShell } from "../shell";
import { runtime } from "./runtime";

export class PowerShellCompletionGenerator implements CompletionGenerator {
  generate(command: CompletionCommand): string {
    const commands = nameCommands(command);

    return [
      `Register-ArgumentCompleter -Native -CommandName ${quotePowerShell(command.name)} -ScriptBlock {`,
      "  param($wordToComplete, $commandAst, $cursorPosition)",
      "",
      `  $commands = @{\n${commands.map(renderCommand).join("\n")}\n  }`,
      "  $choices = [hashtable]::new([System.StringComparer]::Ordinal)",
      ...commands.flatMap(renderChoices),
      "  $children = [hashtable]::new([System.StringComparer]::Ordinal)",
      ...commands.flatMap(renderChildren),
      "",
      `  ${runtime}`,
      "}",
      "",
    ].join("\n");
  }
}

function renderList(values: string[]): string {
  return `@(${values.map(quotePowerShell).join(", ")})`;
}

function renderCommand({ command, id }: NamedCommand): string {
  return `    ${quotePowerShell(String(id))} = @{
      Options = ${renderList(visibleFlags(command.args))}
      Values = ${renderList(valueFlags(command.args))}
      Commands = ${renderList(command.commands.map((child) => child.name))}
    }`;
}

function renderChoices({ command, id }: NamedCommand): string[] {
  return choiceSets(command.args).flatMap(({ keys, choices }) =>
    keys.map((key) => `  $choices[${quotePowerShell(`${id}:${key}`)}] = ${renderList(choices)}`),
  );
}

function renderChildren({ id, children }: NamedCommand): string[] {
  return children.map(
    (child) =>
      `  $children[${quotePowerShell(`${id}:${child.command.name}`)}] = ${quotePowerShell(String(child.id))}`,
  );
}
