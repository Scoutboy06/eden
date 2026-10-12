import type { Args, ArgSchema } from "gunshi";
import { quote, specText } from "./syntax";

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
  const action = arg.choices ? `->${state}` : "_nothing";
  const specs =
    position === undefined
      ? optionSpecs(key, arg, action)
      : [quote(`${position}:${specText(arg.description ?? key)}:${action}`)];

  return {
    specs,
    valueCase: arg.choices
      ? `${state})
      local -a values=( ${arg.choices.map(quote).join(" ")} )
      compadd -- "\${values[@]}"
      ;;`
      : undefined,
  };
}

function optionSpecs(key: string, arg: ArgSchema, action: string): string[] {
  const flags = arg.short ? [`-${arg.short}`, `--${key}`] : [`--${key}`];
  const exclusion = `(${flags.join(" ")})`;
  const description = `[${specText(arg.description ?? "")}]`;
  const value = arg.type === "boolean" ? "" : `:${specText(key)}:${action}`;

  return flags.map((flag) => {
    const attached = arg.type === "boolean" ? "" : flag.startsWith("--") ? "=" : "+";
    return quote(`${exclusion}${flag}${attached}${description}${value}`);
  });
}

interface ArgumentSyntax {
  specs: string[];
  valueCase?: string;
}
