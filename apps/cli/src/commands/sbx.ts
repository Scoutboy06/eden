import { defineCommand } from "../../../../src/modules/cli";
import { sandboxProviderNames } from "../../../../src/modules/sandbox/provider";
import { formatMessage } from "../../../../src/modules/cli/format";

const create = defineCommand({
  name: "create",
  description: "Create a sandbox without entering it",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      required: true,
      description: "Sandbox provider",
    },
    name: { type: "string", required: true, description: "Sandbox name" },
    image: { type: "string", description: "Sandbox container image (defaults to provider choice)" },
  },

  async run(ctx, { sandbox, output }) {
    await sandbox(ctx.values.provider).create({ name: ctx.values.name, image: ctx.values.image });

    output.write({
      data: {},
      human: () =>
        formatMessage(
          `Created sandbox ${ctx.values.name} using ${ctx.values.provider}.`,
          "success",
          "stdout",
        ),
    });
  },
});

export default defineCommand({
  name: "sbx",
  description: "Manage sandboxes",
  subCommands: { create },
});
