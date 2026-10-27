import type { CompletionCommand, CompletionGenerator } from "../generator";
import { quote } from "../shell";
import { renderArguments } from "./arguments";
import { describeEntry } from "./syntax";

export class ZshCompletionGenerator implements CompletionGenerator {
  generate(command: CompletionCommand): string {
    const root = { command, functionName: "_eden_complete_0" };
    const functions = ZshCompletionGenerator.renderCommands(root).join("\n\n");

    return `#compdef ${command.name}\n\n${functions}\n\ncompdef ${root.functionName} ${quote(command.name)}\n`;
  }

  private static renderCommands(node: NamedCommand): string[] {
    const children = node.command.commands.map((command, index) => ({
      command,
      functionName: `${node.functionName}_${index}`,
    }));

    return [
      ZshCompletionGenerator.renderFunction(gatherFunctionValues(node, children)),
      ...children.flatMap(ZshCompletionGenerator.renderCommands),
    ];
  }

  private static renderFunction(values: FunctionValues): string {
    return `${values.functionName}() {
  local context state state_descr line
  typeset -A opt_args
  _arguments -C -S ${values.specs}
  case $state in
    ${values.valueCases}
    command)
      local -a commands=( ${values.descriptions} )
      _describe 'command' commands
      ;;
    arguments)
      case $line[1] in
        ${values.dispatch}
      esac
      ;;
  esac
}`;
  }
}

function gatherFunctionValues(node: NamedCommand, children: NamedCommand[]): FunctionValues {
  const args = renderArguments(node.command.args);
  const specs = [
    ...args.flatMap((arg) => arg.specs),
    ...(children.length ? [quote("1:command:->command"), quote("*::arguments:->arguments")] : []),
  ];

  return {
    functionName: node.functionName,
    specs: specs.join(" "),
    valueCases: args.flatMap((arg) => (arg.valueCase ? [arg.valueCase] : [])).join("\n    "),
    descriptions: children
      .map(({ command }) => describeEntry(command.name, command.description ?? ""))
      .join(" "),
    dispatch: children
      .map(({ command, functionName }) => `${quote(command.name)}) ${functionName} ;;`)
      .join("\n        "),
  };
}

interface NamedCommand {
  command: CompletionCommand;
  functionName: string;
}

interface FunctionValues {
  functionName: string;
  specs: string;
  valueCases: string;
  descriptions: string;
  dispatch: string;
}
