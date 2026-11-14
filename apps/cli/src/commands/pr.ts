import { defineCommand } from "../../../../src/modules/cli";
import { ScmError } from "../../../../src/modules/pull-requests/errors";
import { buildPullRequestPatch } from "../../../../src/modules/pull-requests/edit-input";
import { buildPullRequestCreate } from "../../../../src/modules/pull-requests/create-input";
import { buildPullRequestComment } from "../../../../src/modules/pull-requests/comment-input";
import {
  formatChecks,
  formatDiffOutput,
  formatPullRequestDetails,
  formatPullRequestListItem,
  formatReviewThreads,
  formatReviews,
} from "./pr-output";

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

const list = defineCommand({
  name: "list",
  description: "List GitHub PRs, newest created first",
  args: {
    repo: args.repo,
    remote: args.remote,
    state: {
      type: "string",
      choices: ["open", "closed", "merged", "all"],
      description: "PR state (default: open; closed excludes merged)",
    },
    author: { type: "string", description: "Filter by GitHub user login" },
    draft: { type: "boolean", description: "Show draft PRs only" },
    limit: { type: "number", description: "Maximum matching PRs (positive integer; default: 30)" },
  },
  async run(ctx, { pullRequests, output }) {
    const result = await pullRequests.list({
      ...ctx.values,
      state: ctx.values.state as "open" | "closed" | "merged" | "all" | undefined,
      draft: ctx.values.draft ? true : undefined,
    });

    output.write({
      data: result,
      human: () =>
        result.prs.map((pr) => formatPullRequestListItem(pr)).join("\n") || "No pull requests.",
    });
  },
});

const create = defineCommand({
  name: "create",
  description: "Create a GitHub PR (never pushes branches)",
  args: {
    repo: args.repo,
    remote: args.remote,
    head: {
      type: "string",
      description: "Source branch (defaults to current branch; must already be pushed)",
    },
    base: { type: "string", required: true, description: "Target branch" },
    title: { type: "string", required: true, parse: (value) => value, description: "PR title" },
    body: {
      type: "string",
      parse: (value) => value,
      description: "PR description (defaults to empty)",
    },
    "body-file": {
      type: "string",
      parse: (value) => value,
      description: "Read description from a UTF-8 file; excludes --body",
    },
    draft: { type: "boolean", description: "Create a draft PR" },
    reviewer: {
      type: "string",
      description: "Comma-separated GitHub user logins to request review from",
    },
    label: { type: "string", description: "Comma-separated labels to apply after creation" },
  },
  async run(ctx, { pullRequests, output }) {
    const input = await buildPullRequestCreate({
      ...ctx.values,
      bodyFile: ctx.values["body-file"],
    });
    const pr = await pullRequests.createByReference({ ...ctx.values, ...input });

    if (pr) output.write({ data: { pr }, human: () => `${pr.title}\n${pr.url}` });
  },
});

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
      human: () => formatPullRequestDetails(pr),
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
      human: () => formatChecks(result.checks),
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
      human: () => {
        const reviews = result.reviews
          .map((review) => `${review.state}\t${review.reviewer.name}`)
          .join("\n");
        if (reviews) return reviews;
        if (ctx.values.pending) return "No pending reviewers.";
        if (ctx.values.approved) return "No approved reviewers.";
        return "No reviewers.";
      },
    });
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
    "add-label": {
      type: "string",
      description: "Add comma-separated labels without replacing other labels",
    },
    "remove-label": {
      type: "string",
      description: "Remove comma-separated labels without replacing other labels",
    },
  },
  async run(ctx, { pullRequests, output }) {
    const patch = await buildPullRequestPatch({
      ...ctx.values,
      bodyFile: ctx.values["body-file"],
      targetBranch: ctx.values.base,
      addLabels: ctx.values["add-label"]?.split(",").map((label) => label.trim()),
      removeLabels: ctx.values["remove-label"]?.split(",").map((label) => label.trim()),
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
          `Reviewers\n${formatReviews(reviews)}`,
          `Checks\n${formatChecks(checks)}`,
        ].join("\n\n"),
    });
  },
});

const comment = defineCommand({
  name: "comment",
  description: "Post a GitHub PR comment or reply to an inline review thread",
  args: {
    ref: { type: "positional", required: true, description: "Exact PR number or URL" },
    repo: args.repo,
    remote: args.remote,
    body: {
      type: "string",
      parse: (value) => value,
      description: "Comment body; excludes --body-file",
    },
    "body-file": {
      type: "string",
      parse: (value) => value,
      description: "Read comment body from a UTF-8 file; excludes --body",
    },
    "reply-to": {
      type: "string",
      description:
        "Root inline review comment ID (review:<id> from pr show --comments); discussion replies unsupported",
    },
  },
  async run(ctx, { pullRequests, output }) {
    const input = await buildPullRequestComment({
      ...ctx.values,
      bodyFile: ctx.values["body-file"],
      replyTo: ctx.values["reply-to"],
    });
    const comment = await pullRequests.comment({ ...ctx.values, ...input });

    if (comment) output.write({ data: { comment }, human: () => `${comment.id}\n${comment.url}` });
  },
});

const comments = defineCommand({
  name: "comments",
  description: "List filtered GitHub inline review threads",
  args: {
    ref: { type: "positional", required: true, description: "Exact PR number or URL" },
    repo: args.repo,
    remote: args.remote,
    unresolved: { type: "boolean", description: "Show unresolved threads only" },
    since: {
      type: "string",
      description: "Include threads with comments since this date or timestamp",
    },
    limit: {
      type: "number",
      description: "Maximum matching threads (positive integer; default: 30)",
    },
  },
  async run(ctx, { pullRequests, output }) {
    const result = await pullRequests.comments(ctx.values);
    output.write({
      data: result,
      human: () => formatReviewThreads(result),
    });
  },
});

function threadResolutionCommand(name: "resolve" | "unresolve", isResolved: boolean) {
  return defineCommand({
    name,
    description: `${isResolved ? "Resolve" : "Reopen"} a GitHub inline review thread`,
    args: {
      ref: { type: "positional", required: true, description: "Exact PR number or URL" },
      thread: { type: "positional", required: true, description: "Thread ID from pr comments" },
      repo: args.repo,
      remote: args.remote,
    },
    async run(ctx, { pullRequests, output }) {
      const result = await pullRequests.setReviewThreadResolution(
        { ...ctx.values, threadId: ctx.values.thread },
        isResolved,
      );
      if (result)
        output.write({
          data: { thread: result },
          human: () =>
            `${result.threadId}\n${result.isResolved ? "resolved" : "unresolved"}${result.changed ? "" : " (unchanged)"}`,
        });
    },
  });
}

const resolveThread = threadResolutionCommand("resolve", true);
const unresolveThread = threadResolutionCommand("unresolve", false);

const review = defineCommand({
  name: "review",
  description: "Submit an approve, request-changes or comment review",
  args: {
    ref: { type: "positional", required: true, description: "Exact PR number or URL" },
    repo: args.repo,
    remote: args.remote,
    event: {
      type: "string",
      required: true,
      choices: ["approve", "request-changes", "comment"],
      description: "Review decision",
    },
    body: {
      type: "string",
      parse: (value) => value,
      description: "Review body; excludes --body-file",
    },
    "body-file": {
      type: "string",
      parse: (value) => value,
      description: "Read review body from a UTF-8 file",
    },
    "expected-head": { type: "string", description: "Full head commit SHA to bind this review to" },
  },
  async run(ctx, { pullRequests, output }) {
    const { body } = await buildPullRequestPatch({
      body: ctx.values.body,
      bodyFile: ctx.values["body-file"],
    });
    const result = await pullRequests.review({
      ...ctx.values,
      event: ctx.values.event as "approve" | "request-changes" | "comment",
      body,
      expectedHead: ctx.values["expected-head"],
    });
    if (result)
      output.write({
        data: { review: result },
        human: () => `${result.state}\t${result.reviewer.name}`,
      });
  },
});

const merge = defineCommand({
  name: "merge",
  description: "Merge a GitHub PR using an explicit strategy",
  args: {
    ref: { type: "positional", required: true, description: "Exact PR number or URL" },
    repo: args.repo,
    remote: args.remote,
    method: {
      type: "string",
      required: true,
      choices: ["merge", "squash", "rebase"],
      description: "Merge strategy",
    },
    "expected-head": {
      type: "string",
      description: "Full expected head SHA; stale heads are rejected",
    },
    "delete-branch": {
      type: "boolean",
      description: "Delete the PR source branch after confirmed merge",
    },
  },
  async run(ctx, { pullRequests, output }) {
    const result = await pullRequests.merge({
      ...ctx.values,
      method: ctx.values.method as "merge" | "squash" | "rebase",
      expectedHead: ctx.values["expected-head"],
      deleteBranch: ctx.values["delete-branch"],
    });
    if (result)
      output.write({
        data: result,
        human: () =>
          `${result.pr.title}\n${result.pr.state}\n${result.pr.url}${result.deletedBranch ? "\nSource branch deleted." : ""}`,
      });
  },
});

const close = defineCommand({
  name: "close",
  description: "Close a GitHub PR (already-closed PRs are unchanged; merged PRs are rejected)",
  args: {
    ref: { type: "positional", required: true, description: "Exact PR number or URL" },
    repo: args.repo,
    remote: args.remote,
    comment: {
      type: "string",
      parse: (value) => value,
      description: "Add a comment after newly closing; ignored if already closed",
    },
  },
  async run(ctx, { pullRequests, output }) {
    const pr = await pullRequests.close(ctx.values);

    if (pr) output.write({ data: { pr }, human: () => `${pr.title}\n${pr.state}\n${pr.url}` });
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

const requestReview = defineCommand({
  name: "request-review",
  description: "Request review from GitHub users or teams",
  args: {
    ref: { type: "positional", required: true, description: "Exact PR number or URL" },
    repo: args.repo,
    remote: args.remote,
    reviewer: { type: "string", description: "Comma-separated GitHub user logins" },
    team: { type: "string", description: "Comma-separated GitHub org/team slugs" },
  },
  async run(ctx, { pullRequests, output }) {
    const result = await pullRequests.requestReview({
      ...ctx.values,
      reviewers: ctx.values.reviewer?.split(","),
      teams: ctx.values.team?.split(","),
    });

    if (result)
      output.write({
        data: result,
        human: () =>
          [
            `Requested: ${result.requested.join(", ") || "none"}`,
            `Already pending: ${result.alreadyPending.join(", ") || "none"}`,
          ].join("\n"),
      });
  },
});

const diff = defineCommand({
  name: "diff",
  description: "Show the changed files in a GitHub PR",
  args: {
    ref: { type: "positional", required: true, description: "PR number or URL" },
    repo: args.repo,
    remote: args.remote,
    format: {
      type: "string",
      choices: ["patch", "stat", "json"],
      description:
        "Output format (default: patch; text patches omit unavailable modes/rename metadata and may not apply cleanly; --json uses Eden's standard envelope)",
    },
    path: { type: "string", description: "Filter files by repository-relative glob" },
  },
  async run(ctx, { pullRequests, output }) {
    const result = await pullRequests.diff(ctx.values);
    const format = ctx.values.format ?? "patch";
    const data = { diff: result };

    output.write({
      data,
      human: () => formatDiffOutput(format, data, result),
    });
  },
});

export default defineCommand({
  name: "pr",
  description: "Work with GitHub and Azure DevOps pull requests",
  subCommands: {
    list,
    create,
    show,
    checks,
    reviewers,
    edit,
    status,
    comment,
    comments,
    resolve: resolveThread,
    unresolve: unresolveThread,
    review,
    merge,
    close,
    reopen,
    "request-review": requestReview,
    diff,
  },
});
