import { defineCommand } from "../../../../src/modules/cli";

const create = defineCommand({
  name: "create",
  description: "Create a Git worktree and branch",
  args: {
    name: { type: "string", required: true, description: "Requested worktree name" },
    "base-branch": { type: "string", description: "Starting ref (defaults to HEAD)" },
  },

  async run(ctx, { worktree, output }) {
    const result = await worktree.create({
      name: ctx.values.name,
      baseBranch: ctx.values["base-branch"],
    });

    output.write({
      data: { result },
      human: () => `Created ${result.branch} at ${result.path}`,
    });
  },
});

export default defineCommand({
  name: "worktree",
  description: "Manage Git worktrees",
  subCommands: { create },
});
