import { defineCommand } from "../../command";
import { runCli } from "../../parser";
import completion from "../../../../../apps/cli/src/commands/completion";

const create = defineCommand({
  name: "create",
  description: "Create a workspace",
  toKebab: true,
  args: {
    output: {
      type: "enum",
      short: "o",
      choices: ["table", "json"],
      description: "Output format",
    },
    label: {
      type: "enum",
      choices: ["literal: [x] don't $(print INJECTED)"],
      description: "Choose [label]: don't evaluate $text",
    },
    workspaceRoot: {
      type: "string",
      description: "Workspace root",
    },
  },
  run() {
    throw new Error("Completion must not invoke command handlers");
  },
});

await runCli({
  completion,
  internal: defineCommand({ name: "internal", internal: true }),
  choose: defineCommand({
    name: "choose",
    args: {
      target: {
        type: "positional",
        choices: [
          "alpha",
          "--dash",
          "multi\nline",
          "*literal",
          "spaces and 'quotes' $(printf INJECTED) `printf INJECTED`",
        ],
      },
      next: { type: "positional", choices: ["two"] },
      format: { type: "enum", choices: ["json", "table"] },
      secret: { type: "string", hidden: true },
    },
    run() {
      throw new Error("Completion must not invoke command handlers");
    },
  }),
  "odd:command": defineCommand({
    name: "odd:command",
    description: "A command with punctuation",
  }),
  workspace: defineCommand({
    name: "workspace",
    description: "Manage workspaces",
    subCommands: { create },
  }),
});
