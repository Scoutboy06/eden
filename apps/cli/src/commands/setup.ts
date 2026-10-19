import { defineCommand } from "../../../../src/modules/cli";
import { sandboxProviderNames } from "../../../../src/modules/sandbox/provider";
import { createSandboxProvider } from "../../../../src/modules/sandbox/sandbox.service";

export default defineCommand({
  name: "setup",
  description: "Interactively configure global Eden preferences",
  async run(ctx, { setup, output }) {
    if (ctx.extensions.eden.json || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "Setup requires an interactive terminal and does not support --json. Use eden config set for noninteractive configuration.",
      );
    }

    const { ClackSetupPrompts } = await import("../../../../src/modules/setup/prompts");
    const prompts = new ClackSetupPrompts(
      sandboxProviderNames.map((name) => ({
        name,
        checks: createSandboxProvider(name).readinessChecks(),
      })),
      ctx.extensions.eden.dryRun,
    );
    const result = await setup.run(prompts);
    prompts.finish(result);
    output.raw("");
  },
});
