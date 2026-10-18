import { defineCommand } from "../../../../src/modules/cli";
import { selectConfig } from "../../../../src/modules/config/select";

const get = defineCommand({
  name: "get",
  description: "Read effective configuration or a dot-separated setting",
  args: {
    key: { type: "positional", required: false, description: "Configuration path to read" },
  },

  async run(ctx, { config, output }) {
    const value = selectConfig(await config.read(), ctx.values.key);

    output.write({
      data: { value: value ?? null },
      human: () =>
        value === undefined
          ? ""
          : typeof value === "object"
            ? Bun.YAML.stringify(value).trimEnd()
            : String(value),
    });
  },
});

export default defineCommand({
  name: "config",
  description: "Manage global configuration",
  subCommands: { get },
});
