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

export function requestsFlag(argv: string[], name: string): boolean {
  let enabled = false;
  for (const argument of argv) {
    if (argument === "--") break;
    if (argument === `--${name}` || argument === `--${name}=true`) enabled = true;
    if (argument === `--${name}=false` || argument === `--no-${name}`) enabled = false;
  }

  return enabled;
}
