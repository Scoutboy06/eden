import { ScmError } from "./errors";
import { validatePullRequestComment } from "./comment-input";
import type {
  PullRequestCreateInput,
  PullRequestPatch,
  PullRequestProvider,
  PullRequestRef,
  PullRequestWriter,
  PullRequestReopener,
  PullRequestCloser,
  PullRequestCommenter,
  PullRequestCommentInput,
  PullRequestReviewRequester,
  PullRequestLister,
  PullRequestListQuery,
  RepositoryRef,
  PullRequestDiffer,
  PullRequestDiff,
  PullRequestCommentThreadLister,
  PullRequestReviewInput,
  PullRequestReviewer,
  PullRequestMerger,
  PullRequestMergeInput,
  PullRequestThreadResolver,
} from "./provider";
import { createExecution } from "../execution/execution";
import type { Execution } from "../execution/types";
import {
  createGitContext,
  resolvePullRequestLookup,
  resolveRepository,
  type GitContext,
  type PullRequestInput,
} from "./resolve";
import { repositoryUrl } from "./targets";
import { watchChecks, type WatchOptions } from "./watch";

export class PullRequestService {
  constructor(
    private readonly git: GitContext = createGitContext(process.cwd()),
    private readonly createProvider: (
      repository: RepositoryRef,
    ) => Promise<PullRequestProvider> = async (repository) => {
      const { createPullRequestProvider } = await import("./factory");

      return createPullRequestProvider(repository);
    },
    private readonly execution: Execution = createExecution({ dryRun: false }),
  ) {}

  async list(
    input: Pick<PullRequestInput, "repo" | "remote"> & {
      state?: PullRequestListQuery["state"];
      author?: string;
      draft?: boolean;
      limit?: number;
    },
  ) {
    const state = input.state ?? "open";
    const limit = input.limit ?? 30;
    if (!["open", "closed", "merged", "all"].includes(state))
      throw new ScmError("SCM_INVALID_OPTIONS", "--state must be open, closed, merged or all.");
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new ScmError("SCM_INVALID_OPTIONS", "--limit must be a positive safe integer.");
    if (
      input.author !== undefined &&
      (input.author.length > 39 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(input.author))
    )
      throw new ScmError("SCM_INVALID_OPTIONS", "--author must be a GitHub user login.");
    const repository = await resolveRepository(input, this.git);
    if (repository.provider !== "github")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "eden pr list currently supports GitHub only; Azure DevOps listing is deferred.",
      );
    const provider = await this.createProvider(repository);
    if (!("listPullRequests" in provider) || typeof provider.listPullRequests !== "function")
      throw new ScmError("SCM_UNSUPPORTED_OPERATION", "This provider cannot list pull requests.");
    const prs = await (provider as PullRequestProvider & PullRequestLister).listPullRequests({
      repository,
      state,
      limit,
      ...(input.author !== undefined ? { author: input.author } : {}),
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
    });

    return { repository, prs };
  }

  async create(input: Omit<PullRequestCreateInput, "repository"> & { repository: RepositoryRef }) {
    validateCreate(input);
    if (input.repository.provider !== "github" && (input.reviewers?.length || input.labels?.length))
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "Reviewer and label creation is only supported for GitHub.",
      );
    const provider = await this.createProvider(input.repository);
    const writer = pullRequestWriter(provider);
    let result: Awaited<ReturnType<PullRequestWriter["createPullRequest"]>> | undefined;
    await this.execution.mutate(
      {
        type: `${input.repository.provider}-pr-create`,
        description: `Create ${input.repository.provider} pull request`,
        input,
      },
      async () => {
        result = await writer.createPullRequest(input as PullRequestCreateInput);
      },
    );

    return result;
  }

  async createByReference(
    input: PullRequestInput & {
      title: string;
      body: string;
      base: string;
      draft?: boolean;
      reviewers?: string[];
      labels?: string[];
    },
  ) {
    const lookup = await resolvePullRequestLookup(input, this.git);
    if (lookup.repository.provider !== "github")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "eden pr create currently supports GitHub only; Azure DevOps creation is deferred.",
      );
    if (lookup.kind !== "branch")
      throw new ScmError(
        "SCM_INVALID_OPTIONS",
        "PR creation requires a source branch, not an existing PR reference.",
      );

    return this.create({
      repository: lookup.repository,
      sourceBranch: lookup.sourceBranch,
      targetBranch: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft ?? false,
      reviewers: input.reviewers,
      labels: input.labels,
    });
  }

  async edit(ref: PullRequestRef, patch: PullRequestPatch) {
    validateEdit(ref, patch);
    const provider = await this.createProvider(repositoryForRef(ref));
    const writer = pullRequestWriter(provider);
    let result: Awaited<ReturnType<PullRequestWriter["editPullRequest"]>> | undefined;
    await this.execution.mutate(
      {
        type: `${ref.provider}-pr-edit`,
        description: `Edit ${ref.provider} pull request`,
        input: { ref, patch },
      },
      async () => {
        result = await writer.editPullRequest(ref, patch);
      },
    );

    return result;
  }

  async editByReference(input: PullRequestInput & { ref: string }, patch: PullRequestPatch) {
    return this.edit(await this.exactReference(input), patch);
  }

  async comment(input: PullRequestInput & { ref: string } & PullRequestCommentInput) {
    validatePullRequestComment(input);
    const ref = await this.exactReference(input);
    validateReference(ref);
    if (ref.provider !== "github")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "eden pr comment currently supports GitHub only; Azure DevOps commenting is deferred.",
      );
    const provider = await this.createProvider(repositoryForRef(ref));
    if (!("addComment" in provider) || typeof provider.addComment !== "function")
      throw new ScmError("SCM_UNSUPPORTED_OPERATION", "This provider cannot post PR comments.");
    const commenter = provider as PullRequestProvider & PullRequestCommenter;
    const comment = {
      body: input.body,
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    };
    let result: Awaited<ReturnType<PullRequestCommenter["addComment"]>> | undefined;
    await this.execution.mutate(
      {
        type: "github-pr-comment",
        description: input.replyTo ? "Reply to GitHub review comment" : "Post GitHub PR comment",
        input: { ref, ...comment },
      },
      async () => {
        result = await commenter.addComment(ref, comment);
      },
    );

    return result;
  }

  async comments(
    input: PullRequestInput & {
      ref: string;
      unresolved?: boolean;
      since?: string;
      limit?: number;
    },
  ) {
    const limit = input.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new ScmError("SCM_INVALID_OPTIONS", "--limit must be a positive safe integer.");
    if (input.since !== undefined && Number.isNaN(Date.parse(input.since)))
      throw new ScmError("SCM_INVALID_OPTIONS", "--since must be a valid date or timestamp.");
    const ref = await this.exactReference(input);
    validateReference(ref);
    if (ref.provider !== "github")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "eden pr comments currently supports GitHub only; Azure DevOps thread listing is deferred.",
      );
    const provider = await this.createProvider(repositoryForRef(ref));
    if (!("listCommentThreads" in provider) || typeof provider.listCommentThreads !== "function")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "This provider cannot list PR review threads.",
      );

    return (provider as PullRequestProvider & PullRequestCommentThreadLister).listCommentThreads(
      ref,
      { limit, unresolved: input.unresolved, since: input.since },
    );
  }

  async review(input: PullRequestInput & { ref: string } & PullRequestReviewInput) {
    if (!["approve", "request-changes", "comment"].includes(input.event))
      throw new ScmError(
        "SCM_INVALID_OPTIONS",
        "Review event must be approve, request-changes or comment.",
      );
    if (input.event !== "approve" && !input.body?.trim())
      throw new ScmError(
        "SCM_INVALID_OPTIONS",
        "A nonblank --body is required for this review event.",
      );
    if (input.expectedHead !== undefined && !/^[0-9a-f]{40}$/i.test(input.expectedHead))
      throw new ScmError(
        "SCM_INVALID_OPTIONS",
        "--expected-head must be a full 40-character commit SHA.",
      );
    const ref = await this.exactReference(input);
    validateReference(ref);
    if (ref.provider !== "github")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "eden pr review currently supports GitHub only.",
      );
    const provider = await this.createProvider(repositoryForRef(ref));
    if (!("submitReview" in provider) || typeof provider.submitReview !== "function")
      throw new ScmError("SCM_UNSUPPORTED_OPERATION", "This provider cannot submit PR reviews.");
    const review: PullRequestReviewInput = {
      event: input.event,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.expectedHead !== undefined ? { expectedHead: input.expectedHead } : {}),
    };
    let result: Awaited<ReturnType<PullRequestReviewer["submitReview"]>> | undefined;
    await this.execution.mutate(
      {
        type: "github-pr-review",
        description: "Submit GitHub pull request review",
        input: { ref, ...review },
      },
      async () => {
        result = await (provider as PullRequestProvider & PullRequestReviewer).submitReview(
          ref,
          review,
        );
      },
    );

    return result;
  }

  async setReviewThreadResolution(
    input: PullRequestInput & { ref: string; threadId: string },
    isResolved: boolean,
  ) {
    if (!input.threadId.trim() || input.threadId.length > 256 || /[\r\n\0]/.test(input.threadId))
      throw new ScmError("SCM_INVALID_OPTIONS", "A valid review thread ID is required.");
    const ref = await this.exactReference(input);
    validateReference(ref);
    if (ref.provider !== "github")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "Review thread resolution currently supports GitHub only; Azure DevOps is unsupported.",
      );
    const provider = await this.createProvider(repositoryForRef(ref));
    if (
      !("setReviewThreadResolution" in provider) ||
      typeof provider.setReviewThreadResolution !== "function"
    )
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "This provider cannot resolve review threads.",
      );
    let result:
      | Awaited<ReturnType<PullRequestThreadResolver["setReviewThreadResolution"]>>
      | undefined;
    await this.execution.mutate(
      {
        type: "github-pr-review-thread-resolution",
        description: `${isResolved ? "Resolve" : "Unresolve"} GitHub PR review thread`,
        input: { ref, threadId: input.threadId, isResolved },
      },
      async () => {
        result = await (
          provider as PullRequestProvider & PullRequestThreadResolver
        ).setReviewThreadResolution(ref, input.threadId, isResolved);
      },
    );

    return result;
  }

  async merge(input: PullRequestInput & { ref: string } & PullRequestMergeInput) {
    if (!["merge", "squash", "rebase"].includes(input.method))
      throw new ScmError("SCM_INVALID_OPTIONS", "--method must be merge, squash or rebase.");
    if (input.expectedHead !== undefined && !/^[0-9a-f]{40}$/i.test(input.expectedHead))
      throw new ScmError(
        "SCM_INVALID_OPTIONS",
        "--expected-head must be a full 40-character commit SHA.",
      );
    const ref = await this.exactReference(input);
    validateReference(ref);
    if (ref.provider !== "github")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "eden pr merge currently supports GitHub only.",
      );
    const provider = await this.createProvider(repositoryForRef(ref));
    if (!("mergePullRequest" in provider) || typeof provider.mergePullRequest !== "function")
      throw new ScmError("SCM_UNSUPPORTED_OPERATION", "This provider cannot merge pull requests.");
    const merge: PullRequestMergeInput = {
      method: input.method,
      ...(input.expectedHead !== undefined ? { expectedHead: input.expectedHead } : {}),
      ...(input.deleteBranch ? { deleteBranch: true } : {}),
    };
    let result: Awaited<ReturnType<PullRequestMerger["mergePullRequest"]>> | undefined;
    await this.execution.mutate(
      {
        type: "github-pr-merge",
        description: "Merge GitHub pull request",
        input: { ref, ...merge },
      },
      async () => {
        result = await (provider as PullRequestProvider & PullRequestMerger).mergePullRequest(
          ref,
          merge,
        );
      },
    );

    return result;
  }

  async requestReview(
    input: PullRequestInput & { ref: string; reviewers?: string[]; teams?: string[] },
  ) {
    const reviewers = uniqueReviewTargets(input.reviewers ?? [], "reviewer");
    const teams = uniqueReviewTargets(input.teams ?? [], "team");
    if (reviewers.length + teams.length === 0)
      throw new ScmError("SCM_INVALID_OPTIONS", "Supply at least one --reviewer or --team.");
    const ref = await this.exactReference(input);
    validateReference(ref);
    if (ref.provider !== "github")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "eden pr request-review currently supports GitHub only; Azure DevOps reviewer requests are deferred.",
      );
    const provider = await this.createProvider(repositoryForRef(ref));
    if (!("requestReview" in provider) || typeof provider.requestReview !== "function")
      throw new ScmError("SCM_UNSUPPORTED_OPERATION", "This provider cannot request PR reviews.");
    let result: Awaited<ReturnType<PullRequestReviewRequester["requestReview"]>> | undefined;
    await this.execution.mutate(
      {
        type: "github-pr-request-review",
        description: "Request GitHub pull request review",
        input: { ref, reviewers, teams },
      },
      async () => {
        result = await (provider as PullRequestProvider & PullRequestReviewRequester).requestReview(
          ref,
          { reviewers, teams },
        );
      },
    );

    return result;
  }

  async close(input: PullRequestInput & { ref: string; comment?: string }) {
    if (input.comment !== undefined && !input.comment.trim())
      throw new ScmError("SCM_INVALID_OPTIONS", "--comment must not be blank.");
    const ref = await this.exactReference(input);
    validateReference(ref);
    if (ref.provider !== "github")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "eden pr close currently supports GitHub only; Azure DevOps closing is deferred.",
      );
    const provider = await this.createProvider(repositoryForRef(ref));
    if (!("closePullRequest" in provider) || typeof provider.closePullRequest !== "function")
      throw new ScmError("SCM_UNSUPPORTED_OPERATION", "This provider cannot close pull requests.");
    const closer = provider as PullRequestProvider & PullRequestCloser;
    let result: Awaited<ReturnType<PullRequestCloser["closePullRequest"]>> | undefined;
    await this.execution.mutate(
      {
        type: "github-pr-close",
        description: "Close GitHub pull request; comment only after a new closure",
        input: { ref, ...(input.comment !== undefined ? { comment: input.comment } : {}) },
      },
      async () => {
        result = await closer.closePullRequest(ref, { comment: input.comment });
      },
    );

    return result;
  }

  async reopen(input: PullRequestInput & { ref: string }) {
    const ref = await this.exactReference(input);
    validateReference(ref);
    const provider = await this.createProvider(repositoryForRef(ref));
    if (!("reopenPullRequest" in provider) || typeof provider.reopenPullRequest !== "function")
      throw new ScmError("SCM_UNSUPPORTED_OPERATION", "This provider cannot reopen pull requests.");
    const reopener = provider as PullRequestProvider & PullRequestReopener;
    let result: Awaited<ReturnType<PullRequestReopener["reopenPullRequest"]>> | undefined;
    await this.execution.mutate(
      {
        type: `${ref.provider}-pr-reopen`,
        description: `Reopen ${ref.provider} pull request`,
        input: { ref },
      },
      async () => {
        result = await reopener.reopenPullRequest(ref);
      },
    );

    return result;
  }

  private async exactReference(input: PullRequestInput & { ref: string }) {
    if (!input.ref) invalidInput("An explicit PR number or URL is required for mutations.");
    const lookup = await resolvePullRequestLookup(input, this.git);
    if (lookup.kind !== "exact") invalidInput("An exact PR target is required for mutations.");

    return lookup.ref;
  }

  async show(input: PullRequestInput & { raw?: boolean; comments?: boolean; checks?: boolean }) {
    const { provider, ref } = await this.resolve(input);
    const [pr, comments, checks] = await Promise.all([
      provider.getPullRequest(ref, { raw: input.raw }),
      input.comments ? provider.getComments(ref) : undefined,
      input.checks ? provider.getChecks(ref) : undefined,
    ]);

    return {
      ...pr,
      ...(comments !== undefined ? { comments } : {}),
      ...(checks !== undefined ? { checks } : {}),
    };
  }

  async diff(input: PullRequestInput & { path?: string }): Promise<PullRequestDiff> {
    if (input.path !== undefined) validateDiffPath(input.path);
    const pathGlob = input.path === undefined ? undefined : new Bun.Glob(input.path);
    const { provider, ref } = await this.resolve(input, "diff");
    if (!("getDiff" in provider) || typeof provider.getDiff !== "function")
      throw new ScmError("SCM_UNSUPPORTED_OPERATION", "This provider cannot return PR diffs.");
    const result = await (provider as PullRequestProvider & PullRequestDiffer).getDiff(ref);

    return {
      ...result,
      files:
        pathGlob === undefined
          ? result.files
          : result.files.filter((file) => matchesDiffPath(pathGlob, file.path, file.previousPath)),
    };
  }

  async checks(
    input: PullRequestInput & { requiredOnly?: boolean; watch?: boolean },
    options: WatchOptions = {},
  ) {
    const { provider, ref } = await this.resolve(input);
    const read = (signal?: AbortSignal) =>
      provider.getChecks(ref, { requiredOnly: input.requiredOnly, ...(signal ? { signal } : {}) });

    return { ref, checks: input.watch ? await watchChecks(read, options) : await read() };
  }

  async status(input: PullRequestInput) {
    const { provider, ref } = await this.resolve(input);
    const [pr, reviews, checks] = await Promise.all([
      provider.getPullRequest(ref),
      provider.getReviews(ref),
      provider.getChecks(ref),
    ]);

    return { pr, reviews, checks };
  }

  async reviewers(input: PullRequestInput & { pending?: boolean; approved?: boolean }) {
    if (input.pending && input.approved)
      throw new ScmError("SCM_INVALID_OPTIONS", "--pending and --approved are mutually exclusive.");
    const { provider, ref } = await this.resolve(input);
    const reviews = await provider.getReviews(ref);

    return {
      ref,
      reviews: reviews.filter((review) => {
        if (input.pending) return review.state === "pending";
        if (input.approved)
          return review.state === "approved" || review.state === "approved-with-suggestions";

        return true;
      }),
    };
  }

  private async resolve(input: PullRequestInput, operation?: "diff") {
    const lookup = await resolvePullRequestLookup(input, this.git);
    if (operation === "diff" && lookup.repository.provider !== "github")
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "eden pr diff currently supports GitHub only; Azure DevOps diff is deferred.",
      );
    const provider = await this.createProvider(lookup.repository);
    if (lookup.kind === "exact") return { provider, ref: lookup.ref };

    const candidates = await provider.findOpenPullRequests({
      repository: lookup.repository,
      sourceBranch: lookup.sourceBranch,
    });
    if (candidates.length === 0)
      throw new ScmError("SCM_NOT_FOUND", "No open PR was found for the selected source branch.");
    if (candidates.length > 1) {
      const urls = candidates.map(
        (ref) =>
          `${repositoryUrl(lookup.repository)}/${ref.provider === "github" ? `pull/${ref.number}` : `pullrequest/${ref.id}`}`,
      );
      throw new ScmError(
        "SCM_AMBIGUOUS_PULL_REQUEST",
        `Multiple open PRs match. Supply an exact PR number or URL:\n${urls.join("\n")}`,
      );
    }

    return { provider, ref: candidates[0]! };
  }
}

function pullRequestWriter(provider: PullRequestProvider): PullRequestWriter {
  if (
    !("createPullRequest" in provider) ||
    typeof provider.createPullRequest !== "function" ||
    !("editPullRequest" in provider) ||
    typeof provider.editPullRequest !== "function"
  )
    throw new ScmError(
      "SCM_UNSUPPORTED_OPERATION",
      "This provider cannot create or edit pull requests.",
    );

  return provider as PullRequestProvider & PullRequestWriter;
}

function repositoryForRef(ref: PullRequestRef): RepositoryRef {
  if (ref.provider === "github")
    return { provider: "github", owner: ref.owner, repository: ref.repository };

  return {
    provider: "azure-devops",
    organizationUrl: ref.organizationUrl,
    project: "_",
    repository: "_",
  };
}

function validateCreate(
  input: Omit<PullRequestCreateInput, "repository"> & { repository: RepositoryRef },
) {
  if (input.repository.provider === "github") {
    if (!input.repository.owner.trim() || !input.repository.repository.trim())
      invalidInput("A GitHub repository target is required.");
  } else if (
    !input.repository.organizationUrl.trim() ||
    !input.repository.project.trim() ||
    !input.repository.repository.trim()
  )
    invalidInput("An Azure DevOps organization, project, and repository target are required.");
  if (!input.title.trim()) invalidInput("A pull request title must not be blank.");
  if (
    input.reviewers?.some(
      (name) => name.length > 39 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name),
    )
  )
    invalidInput("Reviewers must be GitHub user logins, not teams or URLs.");
  if (input.labels?.some((name) => !name.trim() || /[\r\n\0]/.test(name)))
    invalidInput("Labels must be nonempty names without null bytes or line breaks.");
  validateBranch(input.sourceBranch);
  validateBranch(input.targetBranch);
}

function validateEdit(ref: PullRequestRef, patch: PullRequestPatch) {
  validateReference(ref);
  const keys = Object.keys(patch);
  if (keys.some((key) => !["title", "body", "targetBranch", "isDraft"].includes(key)))
    invalidInput("Only title, body, targetBranch, and isDraft may be edited.");
  if (keys.length === 0) invalidInput("At least one pull request field must be changed.");
  if (patch.title !== undefined && !patch.title.trim())
    invalidInput("A pull request title must not be blank.");
  if (patch.targetBranch !== undefined) validateBranch(patch.targetBranch);
}

function validateReference(ref: PullRequestRef) {
  if (ref.provider === "github") {
    if (
      !ref.owner.trim() ||
      !ref.repository.trim() ||
      !Number.isSafeInteger(ref.number) ||
      ref.number < 1
    )
      invalidInput("A valid exact GitHub pull request target is required.");
  } else if (!ref.organizationUrl.trim() || !Number.isSafeInteger(ref.id) || ref.id < 1)
    invalidInput("A valid exact Azure DevOps pull request target is required.");
}

function uniqueReviewTargets(values: string[], kind: "reviewer" | "team"): string[] {
  const pattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
  const targets = values.flatMap((value) => value.split(",")).map((value) => value.trim());
  if (targets.some((value) => !value || value.length > 100 || !pattern.test(value)))
    throw new ScmError(
      "SCM_INVALID_OPTIONS",
      `Invalid ${kind} target; supply GitHub ${kind === "reviewer" ? "user logins" : "team slugs"}.`,
    );

  return [...new Map(targets.map((value) => [value.toLowerCase(), value])).values()];
}

function validateBranch(branch: string) {
  if (
    !branch ||
    branch.startsWith("-") ||
    /[~^:?*[\\]/.test(branch) ||
    [...branch].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    branch.includes("..") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock")
  )
    invalidInput("A valid Git branch name is required.");
}

function invalidInput(message: string): never {
  throw new ScmError("SCM_INVALID_REFERENCE", message);
}

function validateDiffPath(pattern: string) {
  if (
    !pattern.trim() ||
    pattern.startsWith("/") ||
    pattern.includes("\\") ||
    pattern.includes("\0") ||
    pattern.split("/").some((segment) => segment === "..")
  )
    throw new ScmError(
      "SCM_INVALID_OPTIONS",
      "--path must be a nonempty repository-relative glob.",
    );
}

function matchesDiffPath(glob: Bun.Glob, path: string, previousPath?: string): boolean {
  return glob.match(path) || (previousPath !== undefined && glob.match(previousPath));
}
