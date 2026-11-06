import { defineCommand } from "../../../../src/modules/cli";
import { ScmError } from "../../../../src/modules/pull-requests/errors";
import { buildPullRequestPatch } from "../../../../src/modules/pull-requests/edit-input";

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
  args: {
    ...args,
    raw: { type: "boolean", description: "Include the raw provider PR response" },
    comments: { type: "boolean", description: "Include discussion and inline review comments" },
    checks: { type: "boolean", description: "Include automated CI and build results" },
  },
  async run(ctx, { pullRequests, output }) {
    const pr = await pullRequests.show(ctx.values);

    output.write({
      data: { pr },
      human: () =>
        [
          `${pr.title}\n${pr.state}${pr.isDraft ? " (draft)" : ""} · ${pr.sourceBranch} → ${pr.targetBranch}\n${pr.url}${pr.body ? `\n\n${pr.body}` : ""}`,
          ...(pr.comments
            ? [
                "Comments",
                pr.comments
                  .map(
                    (comment) =>
                      `${comment.author?.name ?? "Deleted user"}${comment.path ? ` · ${comment.path}${comment.line ? `:${comment.line}` : ""}` : ""}\n${comment.body}`,
                  )
                  .join("\n\n") || "No comments.",
              ]
            : []),
          ...(pr.checks
            ? [
                "Checks",
                pr.checks
                  .map(
                    (check) => `${check.state}\t${check.name}${check.url ? `\t${check.url}` : ""}`,
                  )
                  .join("\n") || "No checks.",
              ]
            : []),
          ...(pr.raw !== undefined ? ["Raw provider data", JSON.stringify(pr.raw, null, 2)] : []),
        ].join("\n\n"),
    });
  },
});

const checks = defineCommand({
  name: "checks",
  description: "Show automated CI and build results for a PR",
  args: {
    ...args,
    "required-only": {
      type: "boolean",
      description: "Show required automated checks only (requires access to branch rules)",
    },
    watch: {
      type: "boolean",
      description: "Wait for checks to finish; fail on failed, cancelled or unknown checks",
    },
    interval: { type: "number", description: "Watch polling interval in seconds (default: 10)" },
    timeout: { type: "number", description: "Watch timeout in seconds (default: 600)" },
  },
  async run(ctx, { pullRequests, output }) {
    if (
      !ctx.values.watch &&
      (ctx.values.interval !== undefined || ctx.values.timeout !== undefined)
    )
      throw new ScmError("SCM_INVALID_OPTIONS", "--interval and --timeout require --watch.");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (ctx.values.watch) {
      process.on("SIGINT", cancel);
      process.on("SIGTERM", cancel);
    }
    let result;
    try {
      result = await pullRequests.checks(
        { ...ctx.values, requiredOnly: ctx.values["required-only"] },
        {
          signal: controller.signal,
          intervalMs: ctx.values.interval === undefined ? undefined : ctx.values.interval * 1000,
          timeoutMs: ctx.values.timeout === undefined ? undefined : ctx.values.timeout * 1000,
        },
      );
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }

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
  args: {
    ...args,
    pending: {
      type: "boolean",
      description: "Show pending reviewers and outstanding requests only",
    },
    approved: {
      type: "boolean",
      description:
        "Show approvals (including Azure approvals with suggestions); excludes --pending",
    },
  },
  async run(ctx, { pullRequests, output }) {
    const result = await pullRequests.reviewers(ctx.values);

    output.write({
      data: result,
      human: () =>
        result.reviews.map((review) => `${review.state}\t${review.reviewer.name}`).join("\n") ||
        (ctx.values.pending
          ? "No pending reviewers."
          : ctx.values.approved
            ? "No approved reviewers."
            : "No reviewers."),
    });
  },
});

const open = defineCommand({
  name: "open",
  description: "Open the native PR page in a browser",
  args: {
    ...args,
    "print-url": { type: "boolean", description: "Print the PR URL without opening a browser" },
  },
  async run(ctx, { pullRequests, output }) {
    const result = await pullRequests.open({ ...ctx.values, printUrl: ctx.values["print-url"] });

    output.write({ data: result, human: () => result.url });
  },
});

const edit = defineCommand({
  name: "edit",
  description: "Update selected PR metadata fields",
  args: {
    ref: { type: "positional", required: true, description: "Exact PR number or URL" },
    repo: args.repo,
    remote: args.remote,
    title: { type: "string", parse: (value) => value, description: "Replace the PR title" },
    body: {
      type: "string",
      parse: (value) => value,
      description: "Replace the description (empty string clears it)",
    },
    "body-file": {
      type: "string",
      parse: (value) => value,
      description: "Read the replacement description from a UTF-8 file",
    },
    base: { type: "string", parse: (value) => value, description: "Change the target branch" },
    draft: { type: "boolean", description: "Mark the PR as a draft; excludes --ready" },
    ready: { type: "boolean", description: "Mark the PR ready for review; excludes --draft" },
  },
  async run(ctx, { pullRequests, output }) {
    const patch = await buildPullRequestPatch({
      ...ctx.values,
      bodyFile: ctx.values["body-file"],
      targetBranch: ctx.values.base,
    });
    const pr = await pullRequests.editByReference(ctx.values, patch);

    if (pr) output.write({ data: { pr }, human: () => `${pr.title}\n${pr.url}` });
  },
});

const status = defineCommand({
  name: "status",
  description: "Show current PR state, reviewers and automated checks",
  args: {
    ...args,
    refresh: {
      type: "boolean",
      description: "Read fresh provider state (status reads are always uncached)",
    },
  },
  async run(ctx, { pullRequests, output }) {
    const result = await pullRequests.status(ctx.values);
    const { pr, reviews, checks } = result;

    output.write({
      data: result,
      human: () =>
        [
          `${pr.title}\n${pr.state}${pr.isDraft ? " (draft)" : ""} · ${pr.sourceBranch} → ${pr.targetBranch}\n${pr.url}`,
          `Reviewers\n${reviews.map((review) => `${review.state}\t${review.reviewer.name}`).join("\n") || "No reviewers."}`,
          `Checks\n${checks.map((check) => `${check.state}\t${check.name}${check.url ? `\t${check.url}` : ""}`).join("\n") || "No checks."}`,
        ].join("\n\n"),
    });
  },
});

const reopen = defineCommand({
  name: "reopen",
  description: "Reopen a closed PR (merged PRs cannot be reopened)",
  args: {
    ref: { type: "positional", required: true, description: "Exact PR number or URL" },
    repo: args.repo,
    remote: args.remote,
  },
  async run(ctx, { pullRequests, output }) {
    const pr = await pullRequests.reopen(ctx.values);

    if (pr) output.write({ data: { pr }, human: () => `${pr.title}\n${pr.state}\n${pr.url}` });
  },
});

export default defineCommand({
  name: "pr",
  description: "Work with GitHub and Azure DevOps pull requests",
  subCommands: { show, checks, reviewers, open, edit, status, reopen },
});
