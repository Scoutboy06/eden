import { defineCommand } from "../../../../src/modules/cli";

const args = {
  ref: {
    type: "positional",
    required: false,
    description: "PR number or URL (defaults to open PR for current branch)",
  },
  repo: { type: "string", description: "HTTPS repository URL on github.com or dev.azure.com" },
  remote: { type: "string", description: "Local Git remote selecting the target repository" },
  head: { type: "string", description: "Source branch to search for an open PR" },
} as const;

const show = defineCommand({
  name: "show",
  description: "Show a PR by number, URL or source branch",
  args,
  async run(ctx, { pullRequests, output }) {
    const pr = await pullRequests.show(ctx.values);

    output.write({
      data: { pr },
      human: () =>
        `${pr.title}\n${pr.state}${pr.isDraft ? " (draft)" : ""} · ${pr.sourceBranch} → ${pr.targetBranch}\n${pr.url}${pr.body ? `\n\n${pr.body}` : ""}`,
    });
  },
});

const checks = defineCommand({
  name: "checks",
  description: "Show automated CI and build results for a PR",
  args,
  async run(ctx, { pullRequests, output }) {
    const result = await pullRequests.checks(ctx.values);

    output.write({
      data: result,
      human: () =>
        result.checks
          .map((check) => `${check.state}\t${check.name}${check.url ? `\t${check.url}` : ""}`)
          .join("\n") || "No checks.",
    });
  },
});

const reviewers = defineCommand({
  name: "reviewers",
  description: "Show current reviewers and their review states",
  args,
  async run(ctx, { pullRequests, output }) {
    const result = await pullRequests.reviewers(ctx.values);

    output.write({
      data: result,
      human: () =>
        result.reviews.map((review) => `${review.state}\t${review.reviewer.name}`).join("\n") ||
        "No reviewers.",
    });
  },
});

export default defineCommand({
  name: "pr",
  description: "Read GitHub and Azure DevOps pull requests",
  subCommands: { show, checks, reviewers },
});
