import type { Args, Awaitable, CommandContext, SubCommandable } from "gunshi";
import type { EdenExtensions } from "./options";
import { createCommandServices } from "./services";
import type { CommandServices } from "./services";

type EdenParams<A extends Args> = {
  args: A;
  extensions: { eden: EdenExtensions };
};

export interface CommandDefinition<A extends Args = Args> {
  name: string;
  description?: string;
  args?: A;
  internal?: boolean;
  toKebab?: boolean;
  subCommands?: Record<string, SubCommandable> | Map<string, SubCommandable>;

  run?(
    ctx: Readonly<CommandContext<EdenParams<A>>>,
    services: CommandServices,
  ): Awaitable<string | void>;
}

export function defineCommand<A extends Args = Args>(definition: CommandDefinition<A>) {
  const { run } = definition;

  return {
    name: definition.name,
    description: definition.description,
    args: definition.args,
    internal: definition.internal,
    toKebab: definition.toKebab,
    subCommands: definition.subCommands,
    run: run
      ? (ctx: Readonly<CommandContext<EdenParams<A>>>) =>
          run(ctx, createCommandServices(ctx.extensions.eden))
      : undefined,
  };
}
