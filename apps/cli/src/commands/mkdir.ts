import { defineCommand, printOperations } from "../../../../src/modules/cli";
import { createExecution } from "../../../../src/modules/execution";
import { FilesystemService } from "../../../../src/modules/fs";

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

  async run(ctx) {
    const { dryRun, json } = ctx.extensions.eden;

    const execution = createExecution({ dryRun });
    const fs = new FilesystemService(execution);

    await fs.mkdir(ctx.values.path);

    printOperations(execution.operations, {
      json,
      dryRun,
    });
  },
});
