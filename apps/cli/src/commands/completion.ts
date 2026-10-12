import type { Args } from "gunshi";
import { choice } from "gunshi/combinators";
import { defineCommand } from "../../../../src/modules/cli";
import { completionCommand } from "../../../../src/modules/cli/completion/generator";
import { ZshCompletionGenerator } from "../../../../src/modules/cli/completion/zsh/generator";

const args = {
  shell: {
    ...choice(["zsh"], {
      required: true,
      description: "Shell to generate completions for",
    }),
    // Preserve enum metadata: Gunshi's positional() drops choices.
    type: "positional",
  },
  stdout: {
    type: "boolean",
    description: "Write the completion script to stdout",
  },
} satisfies Args;

export default defineCommand({
  name: "completion",
  description: "Generate shell completions",
  args,
  async run(ctx) {
    const generator = new ZshCompletionGenerator();
    const globals = Object.fromEntries(
      Object.entries(ctx.args).filter(([name]) => !Object.hasOwn(args, name)),
    );
    process.stdout.write(
      generator.generate({
        name: "eden",
        args: globals,
        commands: await Promise.all(
          [...(ctx.env.subCommands ?? [])]
            .filter(([, command]) => !command.internal)
            .map(([name, command]) => completionCommand(name, command, globals)),
        ),
      }),
    );
  },
});
