import { plugin } from "gunshi";

export const edenOptions = plugin({
  id: "eden",

  setup(ctx) {
    ctx.addGlobalOption("dry-run", {
      type: "boolean",
      description: "Preview changes without executing them",
    });

    ctx.addGlobalOption("json", {
      type: "boolean",
      description: "Output structured JSON",
    });
  },

  extension: (ctx) => ({
    dryRun: ctx.values["dry-run"] === true,
    json: ctx.values.json === true,
  }),
});

export type EdenExtensions = {
  dryRun: boolean;
  json: boolean;
};
