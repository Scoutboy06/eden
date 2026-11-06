import { ScmError } from "./errors";
import type {
  PullRequestCreateInput,
  PullRequestPatch,
  PullRequestProvider,
  PullRequestRef,
  PullRequestWriter,
  RepositoryRef,
} from "./provider";
import { createExecution } from "../execution/execution";
import type { Execution } from "../execution/types";
import {
  createGitContext,
  resolvePullRequestLookup,
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

  async create(input: Omit<PullRequestCreateInput, "repository"> & { repository: RepositoryRef }) {
    validateCreate(input);
    const provider = await this.createProvider(input.repository);
    const writer = pullRequestWriter(provider);
    let result: Awaited<ReturnType<PullRequestWriter["createPullRequest"]>> | undefined;
    await this.execution.mutate(
      { type: "github-pr-create", description: "Create GitHub pull request", input },
      async () => {
        result = await writer.createPullRequest(input as PullRequestCreateInput);
      },
    );

    return result;
  }

  async edit(ref: PullRequestRef, patch: PullRequestPatch) {
    validateEdit(ref, patch);
    const provider = await this.createProvider(repositoryForRef(ref));
    const writer = pullRequestWriter(provider);
    let result: Awaited<ReturnType<PullRequestWriter["editPullRequest"]>> | undefined;
    await this.execution.mutate(
      { type: "github-pr-edit", description: "Edit GitHub pull request", input: { ref, patch } },
      async () => {
        result = await writer.editPullRequest(ref, patch);
      },
    );

    return result;
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

  async checks(
    input: PullRequestInput & { requiredOnly?: boolean; watch?: boolean },
    options: WatchOptions = {},
  ) {
    const { provider, ref } = await this.resolve(input);
    const read = (signal?: AbortSignal) =>
      provider.getChecks(ref, { requiredOnly: input.requiredOnly, ...(signal ? { signal } : {}) });

    return { ref, checks: input.watch ? await watchChecks(read, options) : await read() };
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

  private async resolve(input: PullRequestInput) {
    const lookup = await resolvePullRequestLookup(input, this.git);
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

  throw new ScmError(
    "SCM_UNSUPPORTED_OPERATION",
    "Pull request editing is supported only for GitHub.",
  );
}

function validateCreate(
  input: Omit<PullRequestCreateInput, "repository"> & { repository: RepositoryRef },
) {
  if (input.repository.provider !== "github")
    throw new ScmError(
      "SCM_UNSUPPORTED_OPERATION",
      "Pull request creation is supported only for GitHub.",
    );
  if (!input.repository.owner.trim() || !input.repository.repository.trim())
    invalidInput("A GitHub repository target is required.");
  if (!input.title.trim()) invalidInput("A pull request title must not be blank.");
  validateBranch(input.sourceBranch);
  validateBranch(input.targetBranch);
}

function validateEdit(ref: PullRequestRef, patch: PullRequestPatch) {
  if (ref.provider !== "github")
    throw new ScmError(
      "SCM_UNSUPPORTED_OPERATION",
      "Pull request editing is supported only for GitHub.",
    );
  if (
    !ref.owner.trim() ||
    !ref.repository.trim() ||
    !Number.isSafeInteger(ref.number) ||
    ref.number < 1
  )
    invalidInput("A valid exact GitHub pull request target is required.");
  const keys = Object.keys(patch);
  if (keys.some((key) => !["title", "body", "targetBranch", "isDraft"].includes(key)))
    invalidInput("Only title, body, targetBranch, and isDraft may be edited.");
  if (keys.length === 0) invalidInput("At least one pull request field must be changed.");
  if (patch.title !== undefined && !patch.title.trim())
    invalidInput("A pull request title must not be blank.");
  if (patch.targetBranch !== undefined) validateBranch(patch.targetBranch);
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
