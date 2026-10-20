import { defineCommand } from "../../../../src/modules/cli";
import { selectConfig } from "../../../../src/modules/config/select";

const get = defineCommand({
  name: "get",
  description: "Read effective configuration or a dot-separated setting",
  args: {
    key: { type: "positional", required: false, description: "Configuration path to read" },
  },

  async run(ctx, { readConfig, output }) {
    const value = selectConfig(await readConfig(), ctx.values.key);

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

const set = defineCommand({
  name: "set",
  description: "Set a global configuration leaf setting",
  args: {
    key: { type: "positional", required: true, description: "Configuration path to set" },
    value: { type: "positional", required: true, description: "Value for the setting" },
  },

  async run(ctx, { config, output }) {
    await config.set(ctx.values.key, ctx.values.value);

    output.write({ data: {}, human: () => "" });
  },
});

export default defineCommand({
  name: "config",
  description: "Read effective configuration and manage global settings",
  subCommands: { get, set },
});
