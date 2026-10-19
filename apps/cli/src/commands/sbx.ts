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
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: { type: "string", required: true, description: "Sandbox name" },
    image: { type: "string", description: "Sandbox container image (defaults to provider choice)" },
  },

  async run(ctx, { sandbox, output }) {
    const service = await sandbox(ctx.values.provider);
    await service.create({ name: ctx.values.name, image: ctx.values.image });

    output.write({
      data: {},
      human: () =>
        formatMessage(
          `Created sandbox ${ctx.values.name} using ${service.providerName}.`,
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
