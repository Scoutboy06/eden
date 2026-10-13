import { defineCommand } from "../../../../src/modules/cli";

export default defineCommand({
  name: "mkdir",
  description: "Create a directory",

  args: {
    path: {
      type: "positional",
      description: "Directory to create",
      required: true,
    },
  },

  async run(ctx, { fs, output }) {
    await fs.mkdir(ctx.values.path);

    await output.printOperations();
  },
});
