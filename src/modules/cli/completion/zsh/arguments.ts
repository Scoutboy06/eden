import type { Args, ArgSchema } from "gunshi";
import { quote } from "../shell";
import { specText } from "./syntax";

export function renderArguments(args: Args): ArgumentSyntax[] {
  const visible = Object.entries(args).filter(([, arg]) => !arg.hidden);
  const positionals = visible
    .filter(([, arg]) => arg.type === "positional")
    .map(([key, arg], index) => argumentSyntax(key, arg, `positional_${index}`, index + 1));
  const options = visible
    .filter(([, arg]) => arg.type !== "positional")
    .map(([key, arg], index) => argumentSyntax(key, arg, `option_${index}`));

  return [...positionals, ...options];
}

function argumentSyntax(
  key: string,
  arg: ArgSchema,
  state: string,
  position?: number,
): ArgumentSyntax {
  let action = "_nothing";
  if (arg.choices) action = `->${state}`;

  let specs: string[];
  if (position === undefined) {
    specs = optionSpecs(key, arg, action);
  } else {
    const description = specText(arg.description ?? key);
    specs = [quote(`${position}:${description}:${action}`)];
  }

  let valueCase: string | undefined;
  if (arg.choices) {
    const choices = arg.choices.map(quote).join(" ");
    valueCase = `${state})
      local -a values=( ${choices} )
      compadd -- "\${values[@]}"
      ;;`;
  }
  return {
    specs,
    valueCase,
  };
}

function optionSpecs(key: string, arg: ArgSchema, action: string): string[] {
  const flags = [`--${key}`];
  if (arg.short) flags.unshift(`-${arg.short}`);
  const exclusion = `(${flags.join(" ")})`;
  const description = `[${specText(arg.description ?? "")}]`;
  let value = "";
  if (arg.type !== "boolean") value = `:${specText(key)}:${action}`;

  return flags.map((flag) => {
    let attached = "";
    if (arg.type !== "boolean") attached = flag.startsWith("--") ? "=" : "+";
    return quote(`${exclusion}${flag}${attached}${description}${value}`);
  });
}

export interface ArgumentSyntax {
  specs: string[];
  valueCase?: string;
}
