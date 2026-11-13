import { Octokit } from "@octokit/rest";
import { invalidResponse, providerRequest, ScmError } from "../../modules/pull-requests/errors";
import type { Credential } from "../../modules/pull-requests/credentials";
import { validatePullRequestComment } from "../../modules/pull-requests/comment-input";
import type {
  PullRequest,
  PullRequestCheck,
  PullRequestComment,
  PullRequestProvider,
  PullRequestCreateInput,
  PullRequestPatch,
  PullRequestRef,
  PullRequestWriter,
  PullRequestReopener,
  PullRequestCloser,
  PullRequestCommenter,
  PullRequestCommentInput,
  PullRequestReview,
  RepositoryRef,
  PullRequestLister,
  PullRequestListQuery,
  PullRequestListItem,
  PullRequestReviewRequester,
  PullRequestDiffer,
  PullRequestDiff,
  PullRequestFileDiff,
  PullRequestCommentThreadLister,
  PullRequestCommentThreadsQuery,
  PullRequestReviewer,
  PullRequestReviewInput,
  PullRequestMerger,
  PullRequestMergeInput,
  PullRequestMergeResult,
} from "../../modules/pull-requests/provider";
import { listReviewThreads } from "./review-threads";
import { setReviewThreadResolution } from "./review-thread-resolution";

type GitHubListItem = Awaited<ReturnType<Octokit["pulls"]["list"]>>["data"][number];

export class GitHubApiProvider
  implements
    PullRequestProvider,
    PullRequestWriter,
    PullRequestReopener,
    PullRequestLister,
    PullRequestCloser,
    PullRequestCommenter,
    PullRequestReviewRequester,
    PullRequestDiffer,
    PullRequestCommentThreadLister,
    PullRequestReviewer,
    PullRequestMerger
{
  constructor(private readonly client: Octokit) {}

  listPullRequests(query: PullRequestListQuery): Promise<PullRequestListItem[]> {
    return providerRequest(async () => {
      const repository = githubRepository(query.repository);
      const results: PullRequestListItem[] = [];
      for await (const { data } of this.client.paginate.iterator(this.client.pulls.list, {
        owner: repository.owner,
        repo: repository.repository,
        state: query.state === "merged" ? "closed" : query.state,
        sort: "created",
        direction: "desc",
        per_page: Math.min(100, query.limit),
      })) {
        for (const dataPr of data) {
          const pr = normalizeListItem(dataPr);
          assertPullRequestIdentity(pr, { ...repository, number: dataPr.number });
          if (!matchesListQuery(pr, query)) continue;
          results.push(pr);
          if (results.length === query.limit) return results;
        }
      }

      return results;
    });
  }

  createPullRequest(input: PullRequestCreateInput): Promise<PullRequest> {
    return providerRequest(async () => {
      if (input.repository.provider !== "github")
        throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub repository.");
      const { data } = await this.client.pulls.create({
        owner: input.repository.owner,
        repo: input.repository.repository,
        title: input.title,
        body: input.body,
        head: input.sourceBranch,
        base: input.targetBranch,
        draft: input.draft,
      });
      let pr: PullRequest;
      try {
        pr = normalizePullRequest(data);
        if (!Number.isSafeInteger(data.number) || data.number < 1) invalidResponse();
        assertPullRequestIdentity(pr, { ...input.repository, number: data.number });
        const url = new URL(pr.url);
        if (
          url.origin !== "https://github.com" ||
          url.pathname.toLowerCase() !==
            `/${input.repository.owner}/${input.repository.repository}/pull/${data.number}`.toLowerCase()
        )
          invalidResponse();
      } catch {
        throw new ScmError(
          "SCM_PARTIAL_FAILURE",
          "The pull request may have been created, but its response could not be verified. Inspect the repository before retrying.",
        );
      }
      try {
        if (input.reviewers?.length)
          await this.client.pulls.requestReviewers({
            ...parameters(pr.ref),
            reviewers: input.reviewers,
          });
        if (input.labels?.length)
          await this.client.issues.addLabels({
            owner: input.repository.owner,
            repo: input.repository.repository,
            issue_number: data.number,
            labels: input.labels,
          });
      } catch (error) {
        throw new ScmError(
          "SCM_PARTIAL_FAILURE",
          `PR created: ${pr.url}; reviewers or labels could not be fully applied. Do not retry creation. ${safeFailureDetails(error)}`,
        );
      }

      return pr;
    });
  }

  editPullRequest(ref: PullRequestRef, patch: PullRequestPatch): Promise<PullRequest> {
    return providerRequest(() => editPullRequest(this.client, ref, patch));
  }

  addComment(ref: PullRequestRef, input: PullRequestCommentInput): Promise<PullRequestComment> {
    return providerRequest(async () => {
      if (ref.provider !== "github")
        throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference.");
      const replyId = validatePullRequestComment(input);
      const { data: pr } = await this.client.pulls.get(parameters(ref));
      assertPullRequestIdentity(normalizePullRequest(pr), ref);
      if (replyId !== undefined) {
        const { data: target } = await this.client.pulls.getReviewComment({
          owner: ref.owner,
          repo: ref.repository,
          comment_id: replyId,
        });
        if (target.id !== replyId || !samePrApiUrl(target.pull_request_url, ref))
          throw new ScmError(
            "SCM_INVALID_REFERENCE",
            "The reply target does not belong to the selected pull request.",
          );
        if (target.in_reply_to_id != null)
          throw new ScmError(
            "SCM_UNSUPPORTED_OPERATION",
            "GitHub replies must target a root review comment, not another reply. Use review:<root comment ID>.",
          );
      }
      let data;
      try {
        data = await providerRequest(async () =>
          replyId === undefined
            ? (await postDiscussionComment(this.client, ref, input.body)).data
            : (
                await this.client.pulls.createReplyForReviewComment({
                  ...parameters(ref),
                  comment_id: replyId,
                  body: input.body,
                })
              ).data,
        );
      } catch (error) {
        if (error instanceof ScmError && error.code !== "SCM_REQUEST_FAILED") throw error;
        throw commentConfirmationFailure(ref, error);
      }
      try {
        return normalizeCreatedComment(data, ref, replyId);
      } catch (error) {
        throw commentConfirmationFailure(ref, error);
      }
    });
  }

  requestReview(ref: PullRequestRef, input: { reviewers: string[]; teams: string[] }) {
    return providerRequest(async () => {
      if (ref.provider !== "github")
        throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference.");
      const { data } = await this.client.pulls.get(parameters(ref));
      const current = normalizePullRequest(data);
      assertPullRequestIdentity(current, ref);
      if (current.state !== "open")
        throw new ScmError(
          "SCM_INVALID_STATE",
          "Reviews can only be requested on an open pull request.",
        );
      const requested = await this.requestedReviewers(ref);
      const pendingUsers = new Set(
        requested.filter(({ id }) => id.startsWith("user:")).map(({ name }) => name.toLowerCase()),
      );
      const pendingTeams = new Set(
        requested.filter(({ id }) => id.startsWith("team:")).map(({ name }) => name.toLowerCase()),
      );
      const alreadyPending = [
        ...input.reviewers.filter((name) => pendingUsers.has(name.toLowerCase())),
        ...input.teams.filter((name) => pendingTeams.has(name.toLowerCase())),
      ];
      const reviewers = input.reviewers.filter((name) => !pendingUsers.has(name.toLowerCase()));
      const teams = input.teams.filter((name) => !pendingTeams.has(name.toLowerCase()));
      if (reviewers.length || teams.length) {
        try {
          await providerRequest(() =>
            this.client.pulls.requestReviewers({
              ...parameters(ref),
              reviewers,
              team_reviewers: teams,
            }),
          );
        } catch (error) {
          if (error instanceof ScmError && error.code !== "SCM_REQUEST_FAILED") throw error;
          throw new ScmError(
            "SCM_PARTIAL_FAILURE",
            `Review requests may have been applied for ${[...reviewers, ...teams].join(", ")}; inspect pending reviewers before retrying. ${safeFailureDetails(error)}`,
          );
        }
        try {
          const confirmed = await this.requestedReviewers(ref);
          const confirmedUsers = new Set(
            confirmed
              .filter(({ id }) => id.startsWith("user:"))
              .map(({ name }) => name.toLowerCase()),
          );
          const confirmedTeams = new Set(
            confirmed
              .filter(({ id }) => id.startsWith("team:"))
              .map(({ name }) => name.toLowerCase()),
          );
          const missing = [
            ...reviewers.filter((name) => !confirmedUsers.has(name.toLowerCase())),
            ...teams.filter((name) => !confirmedTeams.has(name.toLowerCase())),
          ];
          if (missing.length) throw new Error("Review requests were not confirmed.");
        } catch (error) {
          throw new ScmError(
            "SCM_PARTIAL_FAILURE",
            `Review requests may have been applied for ${[...reviewers, ...teams].join(", ")}; inspect pending reviewers before retrying. ${safeFailureDetails(error)}`,
          );
        }
      }

      return { requested: [...reviewers, ...teams], alreadyPending };
    });
  }

  closePullRequest(ref: PullRequestRef, options: { comment?: string } = {}): Promise<PullRequest> {
    return providerRequest(async () => {
      if (ref.provider !== "github")
        throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference.");
      if (options.comment !== undefined && !options.comment.trim())
        throw new ScmError("SCM_INVALID_OPTIONS", "--comment must not be blank.");
      const input = parameters(ref);
      const { data } = await this.client.pulls.get(input);
      const current = normalizePullRequest(data);
      assertPullRequestIdentity(current, ref);
      if (current.state === "merged")
        throw new ScmError("SCM_INVALID_STATE", "A merged pull request cannot be closed.");
      if (current.state === "closed") return current;
      const result = await closeGitHubPullRequest(this.client, ref);
      if (options.comment !== undefined) {
        try {
          const { data: comment } = await postDiscussionComment(this.client, ref, options.comment);
          if (!Number.isSafeInteger(comment.id) || comment.id < 1) invalidResponse();
        } catch (error) {
          throw new ScmError(
            "SCM_PARTIAL_FAILURE",
            `PR closed: ${result.url}; the closing comment could not be confirmed. Do not retry automatically; inspect the PR before adding a comment. ${safeFailureDetails(error)}`,
          );
        }
      }

      return result;
    });
  }

  reopenPullRequest(ref: PullRequestRef): Promise<PullRequest> {
    return providerRequest(async () => {
      if (ref.provider !== "github")
        throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference.");
      const input = parameters(ref);
      const { data } = await this.client.pulls.get(input);
      const current = normalizePullRequest(data);
      assertPullRequestIdentity(current, ref);
      if (current.state === "merged")
        throw new ScmError("SCM_INVALID_STATE", "A merged pull request cannot be reopened.");
      if (current.state === "open") return current;
      const { data: updated } = await this.client.pulls.update({ ...input, state: "open" });
      try {
        const result = normalizePullRequest(updated);
        assertPullRequestIdentity(result, ref);
        if (result.state !== "open") invalidResponse();

        return result;
      } catch (error) {
        throw new ScmError(
          "SCM_PARTIAL_FAILURE",
          `The pull request may have reopened, but its response could not be verified. ${safeFailureDetails(error)}`,
        );
      }
    });
  }

  getPullRequest(ref: PullRequestRef, options: { raw?: boolean } = {}): Promise<PullRequest> {
    return providerRequest(async () => {
      const { data } = await this.client.pulls.get(parameters(ref));
      return { ...normalizePullRequest(data, ref), ...(options.raw ? { raw: data } : {}) };
    });
  }

  getDiff(ref: PullRequestRef): Promise<PullRequestDiff> {
    return providerRequest(async () => {
      if (ref.provider !== "github")
        throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference.");

      return readGitHubDiff(this.client, ref);
    });
  }

  getComments(ref: PullRequestRef): Promise<PullRequestComment[]> {
    return providerRequest(async () => {
      const input = { ...parameters(ref), per_page: 100 };
      const [discussion, inline] = await Promise.all([
        this.client.paginate(this.client.issues.listComments, {
          owner: input.owner,
          repo: input.repo,
          issue_number: input.pull_number,
          per_page: 100,
        }),
        this.client.paginate(this.client.pulls.listReviewComments, input),
      ]);

      return [
        ...discussion.map((comment): PullRequestComment => ({
          id: `issue:${comment.id}`,
          body: comment.body ?? "",
          author: comment.user ? { id: `user:${comment.user.id}`, name: comment.user.login } : null,
          url: comment.html_url,
          createdAt: comment.created_at,
        })),
        ...inline.map((comment): PullRequestComment => ({
          id: `review:${comment.id}`,
          body: comment.body,
          author: comment.user ? { id: `user:${comment.user.id}`, name: comment.user.login } : null,
          url: comment.html_url,
          createdAt: comment.created_at,
          path: comment.path,
          ...(comment.line != null ? { line: comment.line } : {}),
          threadId: String(comment.in_reply_to_id ?? comment.id),
        })),
      ].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    });
  }

  listCommentThreads(ref: PullRequestRef, query: PullRequestCommentThreadsQuery) {
    if (ref.provider !== "github")
      return Promise.reject(
        new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference."),
      );

    return listReviewThreads(this.client, ref, query);
  }

  setReviewThreadResolution(ref: PullRequestRef, threadId: string, isResolved: boolean) {
    if (ref.provider !== "github")
      return Promise.reject(
        new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference."),
      );

    return setReviewThreadResolution(this.client, ref, threadId, isResolved);
  }

  submitReview(ref: PullRequestRef, input: PullRequestReviewInput) {
    return providerRequest(async () => {
      if (ref.provider !== "github")
        throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference.");
      const { data } = await this.client.pulls.get(parameters(ref));
      const current = normalizePullRequest(data);
      assertPullRequestIdentity(current, ref);
      const head = data.head?.sha;
      if (!head) invalidResponse();
      if (input.expectedHead && input.expectedHead !== head)
        throw new ScmError(
          "SCM_STALE_HEAD",
          "The PR head changed; inspect the new head before reviewing.",
        );
      const event =
        input.event === "approve"
          ? "APPROVE"
          : input.event === "request-changes"
            ? "REQUEST_CHANGES"
            : "COMMENT";
      let result;
      try {
        result = await providerRequest(() =>
          this.client.pulls.createReview({
            ...parameters(ref),
            commit_id: input.expectedHead ?? head,
            event,
            ...(input.body !== undefined ? { body: input.body } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof ScmError && error.code !== "SCM_REQUEST_FAILED") throw error;
        throw new ScmError(
          "SCM_PARTIAL_FAILURE",
          `The review may have been submitted for head ${input.expectedHead ?? head}; inspect reviews before retrying.`,
        );
      }
      if (!result.data.user || !reviewStates[result.data.state])
        throw new ScmError(
          "SCM_PARTIAL_FAILURE",
          "The review may have been submitted, but its response could not be verified.",
        );

      return {
        reviewer: { id: `user:${result.data.user.id}`, name: result.data.user.login },
        state: reviewStates[result.data.state]!,
      };
    });
  }

  mergePullRequest(
    ref: PullRequestRef,
    input: PullRequestMergeInput,
  ): Promise<PullRequestMergeResult> {
    return mergeGitHubPullRequest(this.client, ref, input);
  }

  findOpenPullRequests(query: {
    repository: RepositoryRef;
    sourceBranch: string;
  }): Promise<PullRequestRef[]> {
    return providerRequest(async () => {
      const repository = githubRepository(query.repository);
      const prs = await this.client.paginate(this.client.pulls.list, {
        owner: repository.owner,
        repo: repository.repository,
        state: "open",
        per_page: 100,
      });

      return prs
        .filter((pr) => pr.head.ref === query.sourceBranch)
        .map((pr) => ({ ...repository, number: pr.number }));
    });
  }

  getChecks(
    ref: PullRequestRef,
    options: { requiredOnly?: boolean; signal?: AbortSignal } = {},
  ): Promise<PullRequestCheck[]> {
    return providerRequest(async () => {
      const input = parameters(ref);
      const request = { signal: options.signal };
      const { data: pr } = await this.client.pulls.get({ ...input, request });
      if (!pr.head?.sha) invalidResponse();
      const target = {
        owner: input.owner,
        repo: input.repo,
        ref: pr.head.sha,
        per_page: 100,
        request,
      };
      const [runs, statuses] = await Promise.all([
        this.client.paginate(
          this.client.checks.listForRef.defaults({
            url: this.client.checks.listForRef.endpoint.DEFAULTS.url,
            request,
          }) as typeof this.client.checks.listForRef,
          { ...target, filter: "latest" },
        ),
        this.client.paginate(
          this.client.repos.listCommitStatusesForRef.defaults({
            url: this.client.repos.listCommitStatusesForRef.endpoint.DEFAULTS.url,
            request,
          }) as typeof this.client.repos.listCommitStatusesForRef,
          target,
        ),
      ]);
      const latest = new Map<string, (typeof statuses)[number]>();
      for (const status of statuses) {
        const existing = latest.get(status.context);
        if (!existing || status.id > existing.id) latest.set(status.context, status);
      }

      const checks: PullRequestCheck[] = [
        ...runs.map((run): PullRequestCheck => ({
          id: `check:${run.id}`,
          name: run.name,
          ...(run.html_url ? { url: run.html_url } : {}),
          state:
            run.status === "completed"
              ? conclusion(run.conclusion)
              : run.status === "in_progress"
                ? "running"
                : "pending",
        })),
        ...[...latest.values()].map((status): PullRequestCheck => ({
          id: `status:${status.id}`,
          name: status.context,
          ...(status.target_url ? { url: status.target_url } : {}),
          state:
            status.state === "success"
              ? "passed"
              : status.state === "pending"
                ? "pending"
                : status.state === "failure" || status.state === "error"
                  ? "failed"
                  : "unknown",
        })),
      ];
      if (!options.requiredOnly) return checks;
      if (!pr.base?.ref) invalidResponse();
      const required = await this.requiredChecks(
        input.owner,
        input.repo,
        pr.base.ref,
        options.signal,
      );

      return required.flatMap((requirement) => {
        const matches = checks.filter((check) => {
          if (check.name !== requirement.context) return false;
          if (requirement.appId == null || requirement.appId === -1) return true;

          return runs.some(
            (run) => check.id === `check:${run.id}` && run.app?.id === requirement.appId,
          );
        });

        return matches.length > 0
          ? matches
          : [
              {
                id: `required:${requirement.context}:${requirement.appId ?? "any"}`,
                name: requirement.context,
                state: "pending" as const,
              },
            ];
      });
    });
  }

  private async requiredChecks(owner: string, repo: string, branch: string, signal?: AbortSignal) {
    const target = { owner, repo, branch, request: { signal } };
    const [protection, rules] = await Promise.all([
      this.client.repos.getBranchProtection(target).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 404
        )
          return undefined;

        throw error;
      }),
      this.client.paginate(
        this.client.repos.getBranchRules.defaults({
          url: this.client.repos.getBranchRules.endpoint.DEFAULTS.url,
          request: { signal },
        }) as typeof this.client.repos.getBranchRules,
        { ...target, per_page: 100 },
      ),
    ]);
    if (rules.some((rule) => rule.type === "workflows"))
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "Required workflow rules cannot be projected as named status checks. Run without --required-only.",
      );
    const required = new Map<string, { context: string; appId?: number | null }>();
    const add = (context: string, appId?: number | null) =>
      required.set(JSON.stringify([context, appId ?? -1]), { context, appId });
    const classic = protection?.data.required_status_checks;
    for (const check of classic?.checks ?? []) add(check.context, check.app_id);
    for (const name of classic?.contexts ?? []) {
      if (!classic?.checks?.some((check) => check.context === name)) add(name);
    }
    for (const rule of rules) {
      if (rule.type !== "required_status_checks") continue;
      if (!rule.parameters) invalidResponse();
      for (const check of rule.parameters.required_status_checks)
        add(check.context, check.integration_id);
    }

    return [...required.values()];
  }

  getReviews(ref: PullRequestRef): Promise<PullRequestReview[]> {
    return providerRequest(async () => {
      const input = { ...parameters(ref), per_page: 100 };
      const [reviews, requested] = await Promise.all([
        this.client.paginate(this.client.pulls.listReviews, input),
        this.requestedReviewers(ref),
      ]);
      const latest = new Map<string, PullRequestReview>();
      for (const review of reviews) {
        if (!review.user || review.state === "PENDING") continue;
        const id = `user:${review.user.id}`;
        const state = reviewStates[review.state] ?? "unknown";
        const existing = latest.get(id);
        if (state === "commented" && existing && existing.state !== "commented") continue;
        latest.set(id, { reviewer: { id, name: review.user.login }, state });
      }
      for (const reviewer of requested) latest.set(reviewer.id, { reviewer, state: "pending" });

      return [...latest.values()];
    });
  }

  private async requestedReviewers(ref: PullRequestRef) {
    const result: PullRequestReview["reviewer"][] = [];
    for (let page = 1; ; page++) {
      const { data } = await this.client.pulls.listRequestedReviewers({
        ...parameters(ref),
        per_page: 100,
        page,
      });
      result.push(
        ...data.users.map((user) => ({ id: `user:${user.id}`, name: user.login })),
        ...data.teams.map((team) => ({ id: `team:${team.id}`, name: team.slug })),
      );
      if (data.users.length + data.teams.length < 100) return result;
    }
  }
}

export function createGitHubApiProvider(credential?: Credential): GitHubApiProvider {
  return new GitHubApiProvider(
    new Octokit({
      auth: credential?.token,
      request: { timeout: 30_000, redirect: "error" },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    }),
  );
}

const reviewStates: Record<string, PullRequestReview["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

function parameters(ref: PullRequestRef) {
  if (ref.provider !== "github")
    throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference.");

  return { owner: ref.owner, repo: ref.repository, pull_number: ref.number };
}

async function mergeGitHubPullRequest(
  client: Octokit,
  ref: PullRequestRef,
  input: PullRequestMergeInput,
): Promise<PullRequestMergeResult> {
  if (ref.provider !== "github")
    throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference.");
  const target = await inspectMergeTarget(client, ref, input);
  await mergeExpectedHead(client, target, input.method);
  const pr = await confirmMergedPullRequest(client, target);
  if (input.deleteBranch) await deleteMergedSourceBranch(client, target, pr);

  return { pr, deletedBranch: input.deleteBranch ?? false };
}

type MergeTarget = {
  ref: Extract<PullRequestRef, { provider: "github" }>;
  parameters: ReturnType<typeof parameters>;
  head: string;
  branch: string;
  sourceOwner: string;
  sourceRepository: string;
};

async function inspectMergeTarget(
  client: Octokit,
  ref: Extract<PullRequestRef, { provider: "github" }>,
  input: PullRequestMergeInput,
): Promise<MergeTarget> {
  const params = parameters(ref);
  const { data } = await client.pulls.get(params);
  const current = normalizePullRequest(data);
  assertPullRequestIdentity(current, ref);
  if (current.state !== "open")
    throw new ScmError("SCM_INVALID_STATE", "Only an open pull request can be merged.");
  const head = data.head?.sha;
  const branch = data.head?.ref;
  const base = data.base?.ref;
  const sourceOwner = data.head?.repo?.owner?.login;
  const sourceRepository = data.head?.repo?.name;
  if (!head || !branch || !base || !sourceOwner || !sourceRepository) invalidResponse();
  if (input.expectedHead && input.expectedHead !== head)
    throw new ScmError(
      "SCM_STALE_HEAD",
      "The PR head changed; inspect the new head before merging.",
    );
  if (input.deleteBranch && !isSafeSourceBranch(branch, base))
    throw new ScmError(
      "SCM_INVALID_REFERENCE",
      "The PR source branch is not a safe distinct branch name.",
    );
  if (
    input.deleteBranch &&
    (sourceOwner.toLowerCase() !== ref.owner.toLowerCase() ||
      sourceRepository.toLowerCase() !== ref.repository.toLowerCase())
  )
    throw new ScmError(
      "SCM_UNSUPPORTED_OPERATION",
      "Automatic deletion is only supported for a source branch in this repository; fork branches are left unchanged.",
    );

  return { ref, parameters: params, head, branch, sourceOwner, sourceRepository };
}

function isSafeSourceBranch(branch: string, base: string) {
  return branch !== base && /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes("..");
}

async function mergeExpectedHead(
  client: Octokit,
  target: MergeTarget,
  method: PullRequestMergeInput["method"],
) {
  try {
    const result = await client.pulls.merge({
      ...target.parameters,
      merge_method: method,
      sha: target.head,
    });
    if (!result.data.merged)
      throw new ScmError(
        "SCM_INVALID_STATE",
        `GitHub did not merge the PR: ${result.data.message}`,
      );
  } catch (error) {
    throw mergeFailure(error);
  }
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return;

  return typeof error.status === "number" ? error.status : undefined;
}

function mergeFailure(error: unknown): ScmError {
  const status = responseStatus(error);
  if (status === 409)
    return new ScmError(
      "SCM_MERGE_REJECTED",
      "GitHub rejected the merge because the head changed or a merge conflict prevents it; inspect the PR before retrying.",
    );
  if (status === 405)
    return new ScmError(
      "SCM_INVALID_STATE",
      "GitHub rejected the merge because the PR is not currently mergeable or repository policy prevents this method.",
    );
  if (status === 401)
    return new ScmError(
      "SCM_AUTHENTICATION_FAILED",
      "Provider authentication is required or was rejected.",
    );
  if (status === 403)
    return new ScmError("SCM_ACCESS_DENIED", "The provider denied access to this operation.");
  if (status === 404)
    return new ScmError("SCM_NOT_FOUND", "The pull request was not found or is not accessible.");
  if (status === 429)
    return new ScmError(
      "SCM_RATE_LIMITED",
      "The provider rate limit was exceeded. Try again later.",
    );
  if (status === 400 || status === 422)
    return new ScmError("SCM_INVALID_REQUEST", "The provider rejected the merge parameters.");
  if (error instanceof ScmError && error.code !== "SCM_REQUEST_FAILED") return error;

  return new ScmError(
    "SCM_PARTIAL_FAILURE",
    "The merge may have been applied; inspect the PR before retrying.",
  );
}

async function confirmMergedPullRequest(
  client: Octokit,
  target: MergeTarget,
): Promise<PullRequest> {
  try {
    const confirmed = await client.pulls.get(target.parameters);
    const pr = normalizePullRequest(confirmed.data);
    assertPullRequestIdentity(pr, target.ref);
    if (pr.state !== "merged") invalidResponse();

    return pr;
  } catch {
    throw new ScmError(
      "SCM_PARTIAL_FAILURE",
      "The PR merged, but its state could not be confirmed. Do not retry.",
    );
  }
}

async function deleteMergedSourceBranch(client: Octokit, target: MergeTarget, pr: PullRequest) {
  try {
    const input = {
      owner: target.sourceOwner,
      repo: target.sourceRepository,
      ref: `heads/${target.branch}`,
    };
    const source = await client.git.getRef(input);
    if (source.data.object.sha !== target.head)
      throw new Error("The PR source branch advanced after inspection.");
    await client.git.deleteRef(input);
  } catch (error) {
    if (responseStatus(error) === 404) return;
    throw new ScmError(
      "SCM_PARTIAL_FAILURE",
      `PR merged: ${pr.url}; source branch ${target.branch} could not be safely deleted. The merge succeeded.`,
    );
  }
}

async function editPullRequest(client: Octokit, ref: PullRequestRef, patch: PullRequestPatch) {
  if (ref.provider !== "github")
    throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference.");
  const input = parameters(ref);
  const { data: current } = await client.pulls.get(input);
  const restPatch = restFields(patch);
  let updated = current;
  if (Object.keys(restPatch).length > 0)
    updated = (await client.pulls.update({ ...input, ...restPatch })).data;
  if (patch.isDraft !== undefined && patch.isDraft !== (updated.draft ?? false)) {
    try {
      await providerRequest(() => changeDraftState(client, updated.node_id, patch.isDraft!));
    } catch (error) {
      if (Object.keys(restPatch).length === 0) throw error;
      const cause = safeFailureDetails(error);
      throw new ScmError(
        "SCM_PARTIAL_FAILURE",
        `Pull request fields were updated, but its draft state change failed. ${cause}`,
      );
    }
    try {
      updated = (await providerRequest(() => client.pulls.get(input))).data;
    } catch (error) {
      throw new ScmError(
        "SCM_PARTIAL_FAILURE",
        `Pull request changes may have been applied, but confirmation failed. ${safeFailureDetails(error)}`,
      );
    }
  }
  const result = normalizePullRequest(updated);
  assertPullRequestIdentity(result, ref);

  return result;
}

function postDiscussionComment(
  client: Octokit,
  ref: Extract<PullRequestRef, { provider: "github" }>,
  body: string,
) {
  return client.issues.createComment({
    owner: ref.owner,
    repo: ref.repository,
    issue_number: ref.number,
    body,
  });
}

function samePrApiUrl(url: string, ref: Extract<PullRequestRef, { provider: "github" }>): boolean {
  return (
    url?.toLowerCase() ===
    `https://api.github.com/repos/${ref.owner}/${ref.repository}/pulls/${ref.number}`.toLowerCase()
  );
}

function commentConfirmationFailure(
  ref: Extract<PullRequestRef, { provider: "github" }>,
  error: unknown,
): ScmError {
  return new ScmError(
    "SCM_PARTIAL_FAILURE",
    `The comment may have been posted on https://github.com/${ref.owner}/${ref.repository}/pull/${ref.number}, but could not be confirmed. Inspect the PR before retrying to avoid duplicate comments. ${safeFailureDetails(error)}`,
  );
}

function normalizeCreatedComment(
  data:
    | Awaited<ReturnType<Octokit["issues"]["createComment"]>>["data"]
    | Awaited<ReturnType<Octokit["pulls"]["createReplyForReviewComment"]>>["data"],
  ref: Extract<PullRequestRef, { provider: "github" }>,
  replyId: number | undefined,
): PullRequestComment {
  if (!Number.isSafeInteger(data.id) || data.id < 1 || typeof data.body !== "string")
    invalidResponse();
  const url = new URL(data.html_url);
  const path = `/${ref.owner}/${ref.repository}/pull/${ref.number}`.toLowerCase();
  if (
    url.origin !== "https://github.com" ||
    !(url.pathname.toLowerCase() === path || url.pathname.toLowerCase().startsWith(`${path}/`))
  )
    invalidResponse();
  if (replyId === undefined) {
    if (
      !("issue_url" in data) ||
      data.issue_url.toLowerCase() !==
        `https://api.github.com/repos/${ref.owner}/${ref.repository}/issues/${ref.number}`.toLowerCase()
    )
      invalidResponse();
  } else if (
    !("pull_request_url" in data) ||
    !samePrApiUrl(data.pull_request_url, ref) ||
    data.in_reply_to_id !== replyId
  )
    invalidResponse();

  return {
    id: `${replyId === undefined ? "issue" : "review"}:${data.id}`,
    body: data.body,
    author: data.user ? { id: `user:${data.user.id}`, name: data.user.login } : null,
    url: data.html_url,
    createdAt: data.created_at,
    ...(replyId !== undefined ? { threadId: String(replyId) } : {}),
  };
}

async function closeGitHubPullRequest(
  client: Octokit,
  ref: Extract<PullRequestRef, { provider: "github" }>,
): Promise<PullRequest> {
  let updated;
  try {
    updated = (
      await providerRequest(() => client.pulls.update({ ...parameters(ref), state: "closed" }))
    ).data;
  } catch (error) {
    if (error instanceof ScmError && error.code !== "SCM_REQUEST_FAILED") throw error;
    throw new ScmError(
      "SCM_PARTIAL_FAILURE",
      `The PR may have closed: https://github.com/${ref.owner}/${ref.repository}/pull/${ref.number}. Inspect it before retrying. ${safeFailureDetails(error)}`,
    );
  }
  try {
    const result = normalizePullRequest(updated);
    assertPullRequestIdentity(result, ref);
    if (result.state !== "closed") invalidResponse();

    return result;
  } catch (error) {
    throw new ScmError(
      "SCM_PARTIAL_FAILURE",
      `The PR may have closed: https://github.com/${ref.owner}/${ref.repository}/pull/${ref.number}, but its response could not be verified. ${safeFailureDetails(error)}`,
    );
  }
}

function normalizeListItem(data: GitHubListItem): PullRequestListItem {
  if (
    !Number.isSafeInteger(data.number) ||
    data.number < 1 ||
    !["open", "closed"].includes(data.state) ||
    !(data.merged_at === null || typeof data.merged_at === "string") ||
    (data.user != null && typeof data.user.login !== "string")
  )
    invalidResponse();

  return {
    ...normalizePullRequest({ ...data, merged: data.merged_at !== null }),
    author: data.user ? { id: `user:${data.user.id}`, name: data.user.login } : null,
  };
}

type GitHubDiffSnapshot = {
  baseCommit: string;
  headCommit: string;
  changedFiles: number | undefined;
};

async function readGitHubDiff(
  client: Octokit,
  ref: Extract<PullRequestRef, { provider: "github" }>,
): Promise<PullRequestDiff> {
  const input = parameters(ref);
  const snapshot = await readGitHubDiffSnapshot(client, ref);
  const result = await readGitHubDiffFiles(client, input);
  await confirmGitHubDiffSnapshot(client, input, ref, snapshot);
  if (snapshot.changedFiles !== undefined && result.files.length > snapshot.changedFiles)
    invalidResponse();

  return {
    ref,
    baseCommit: snapshot.baseCommit,
    headCommit: snapshot.headCommit,
    files: result.files,
    completeness: githubDiffCompleteness(result, snapshot.changedFiles),
  };
}

async function readGitHubDiffSnapshot(
  client: Octokit,
  ref: Extract<PullRequestRef, { provider: "github" }>,
): Promise<GitHubDiffSnapshot> {
  const { data } = await client.pulls.get(parameters(ref));
  assertPullRequestIdentity(normalizePullRequest(data), ref);
  const baseCommit = data.base?.sha;
  const headCommit = data.head?.sha;
  const changedFiles = data.changed_files;
  if (
    !baseCommit ||
    !headCommit ||
    (changedFiles !== undefined && (!Number.isSafeInteger(changedFiles) || changedFiles < 0))
  )
    invalidResponse();

  return { baseCommit, headCommit, changedFiles };
}

async function readGitHubDiffFiles(
  client: Octokit,
  input: ReturnType<typeof parameters>,
): Promise<{ files: PullRequestFileDiff[]; reachedLimit: boolean }> {
  const files: PullRequestFileDiff[] = [];
  let reachedLimit = false;
  for await (const { data } of client.paginate.iterator(client.pulls.listFiles, {
    ...input,
    per_page: 100,
  })) {
    files.push(...data.map(normalizeFileDiff));
    if (files.length >= 3000) {
      reachedLimit = true;
      break;
    }
  }

  return { files, reachedLimit };
}

async function confirmGitHubDiffSnapshot(
  client: Octokit,
  input: ReturnType<typeof parameters>,
  ref: Extract<PullRequestRef, { provider: "github" }>,
  snapshot: GitHubDiffSnapshot,
) {
  const { data } = await client.pulls.get(input);
  assertPullRequestIdentity(normalizePullRequest(data), ref);
  if (data.base?.sha !== snapshot.baseCommit || data.head?.sha !== snapshot.headCommit)
    throw new ScmError(
      "SCM_PARTIAL_FAILURE",
      "The PR changed while its file diff was being read. Retry to get a diff for stable commits.",
    );
  if (snapshot.changedFiles !== undefined && data.changed_files !== snapshot.changedFiles)
    throw new ScmError(
      "SCM_PARTIAL_FAILURE",
      "The PR file count changed while its file diff was being read. Retry for a stable result.",
    );
}

function githubDiffCompleteness(
  result: { files: PullRequestFileDiff[]; reachedLimit: boolean },
  changedFiles: number | undefined,
): PullRequestDiff["completeness"] {
  if (changedFiles !== undefined && result.files.length < changedFiles)
    return {
      status: "incomplete",
      reason: `GitHub reported ${changedFiles} changed files but returned ${result.files.length}; file lists are limited to 3,000 files.`,
    };
  if (result.reachedLimit && changedFiles === undefined)
    return {
      status: "incomplete",
      reason: "GitHub file-list completeness cannot be verified at the 3,000-file limit.",
    };

  return { status: "complete" };
}

function normalizeFileDiff(
  data: Awaited<ReturnType<Octokit["pulls"]["listFiles"]>>["data"][number],
): PullRequestFileDiff {
  if (
    typeof data.filename !== "string" ||
    data.filename.length === 0 ||
    !Number.isSafeInteger(data.additions) ||
    data.additions < 0 ||
    !Number.isSafeInteger(data.deletions) ||
    data.deletions < 0 ||
    (data.previous_filename !== undefined && typeof data.previous_filename !== "string")
  )
    invalidResponse();
  const statuses: Record<string, PullRequestFileDiff["status"]> = {
    added: "added",
    modified: "modified",
    removed: "deleted",
    renamed: "renamed",
    copied: "copied",
    changed: "type-changed",
  };

  return {
    path: data.filename,
    ...(data.previous_filename ? { previousPath: data.previous_filename } : {}),
    status: statuses[data.status] ?? "unknown",
    additions: data.additions,
    deletions: data.deletions,
    patch: normalizeFilePatch(data.patch, data.additions, data.deletions),
  };
}

function normalizeFilePatch(
  patch: string | undefined,
  additions: number,
  deletions: number,
): PullRequestFileDiff["patch"] {
  if (typeof patch !== "string") return { status: "unavailable", reason: "not-provided" };
  const inspection = inspectFilePatch(patch);
  if (inspection.status === "truncated") return { status: "truncated", text: patch };
  if (inspection.status === "invalid") return { status: "unavailable", reason: "not-provided" };
  if (inspection.additions < additions || inspection.deletions < deletions)
    return { status: "truncated", text: patch };
  if (inspection.additions > additions || inspection.deletions > deletions)
    return { status: "unavailable", reason: "not-provided" };

  return { status: "available", text: patch };
}

type PatchInspection = {
  status: "complete" | "truncated" | "invalid";
  additions: number;
  deletions: number;
};

type PatchScan = {
  hunks: number;
  expectedAdditions: number;
  expectedDeletions: number;
  additions: number;
  deletions: number;
  hunkAdditions: number;
  hunkDeletions: number;
};

function inspectFilePatch(patch: string): PatchInspection {
  const scan: PatchScan = {
    hunks: 0,
    expectedAdditions: 0,
    expectedDeletions: 0,
    additions: 0,
    deletions: 0,
    hunkAdditions: 0,
    hunkDeletions: 0,
  };
  const hasTrailingNewline = patch.endsWith("\n");
  for (const line of patch.split("\n")) {
    const status = consumePatchLine(line, scan, hasTrailingNewline);
    if (status) return { status, additions: scan.additions, deletions: scan.deletions };
  }
  if (scan.hunks === 0) return { status: "invalid", additions: 0, deletions: 0 };

  return {
    status: compareHunkCounts(
      scan.hunkAdditions,
      scan.hunkDeletions,
      scan.expectedAdditions,
      scan.expectedDeletions,
    ),
    additions: scan.additions,
    deletions: scan.deletions,
  };
}

function consumePatchLine(
  line: string,
  scan: PatchScan,
  hasTrailingNewline: boolean,
): PatchInspection["status"] | undefined {
  const hunk = consumePatchHunk(line, scan);
  if (hunk !== undefined) return hunk === "complete" ? undefined : hunk;
  const kind = patchLineKind(line, scan.hunks > 0, hasTrailingNewline);
  if (kind === "invalid") return "invalid";
  if (kind === "addition") {
    scan.additions++;
    scan.hunkAdditions++;
  } else if (kind === "deletion") {
    scan.deletions++;
    scan.hunkDeletions++;
  } else if (kind === "context") {
    scan.hunkAdditions++;
    scan.hunkDeletions++;
  }

  return undefined;
}

function consumePatchHunk(line: string, scan: PatchScan): PatchInspection["status"] | undefined {
  const range = patchHunkRange(line);
  if (!range) return;
  if (scan.hunks > 0) {
    const status = compareHunkCounts(
      scan.hunkAdditions,
      scan.hunkDeletions,
      scan.expectedAdditions,
      scan.expectedDeletions,
    );
    if (status !== "complete") return status;
  }
  scan.hunks++;
  scan.expectedAdditions = range.additions;
  scan.expectedDeletions = range.deletions;
  scan.hunkAdditions = 0;
  scan.hunkDeletions = 0;

  return "complete";
}

function patchHunkRange(line: string): { additions: number; deletions: number } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
  if (!match) return;

  return { deletions: Number(match[2] ?? 1), additions: Number(match[4] ?? 1) };
}

function patchLineKind(
  line: string,
  inHunk: boolean,
  hasTrailingNewline: boolean,
): "addition" | "deletion" | "context" | "ignored" | "invalid" {
  if ((line === "" && hasTrailingNewline) || line.startsWith("\\ No newline at end of file"))
    return "ignored";
  if (!inHunk) return "invalid";
  if (line.startsWith("+")) return "addition";
  if (line.startsWith("-")) return "deletion";
  if (line.startsWith(" ")) return "context";

  return "invalid";
}

function compareHunkCounts(
  additions: number,
  deletions: number,
  expectedAdditions: number,
  expectedDeletions: number,
): PatchInspection["status"] {
  if (additions === expectedAdditions && deletions === expectedDeletions) return "complete";
  if (additions < expectedAdditions || deletions < expectedDeletions) return "truncated";

  return "invalid";
}

function matchesListQuery(pr: PullRequestListItem, query: PullRequestListQuery): boolean {
  if (query.state !== "all" && pr.state !== query.state) return false;
  if (query.author !== undefined && pr.author?.name.toLowerCase() !== query.author.toLowerCase())
    return false;

  return query.draft === undefined || pr.isDraft === query.draft;
}

function safeFailureDetails(error: unknown): string {
  return error instanceof ScmError
    ? `${error.code}: ${error.message}`
    : "The provider request failed.";
}

function restFields(patch: PullRequestPatch) {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.targetBranch !== undefined ? { base: patch.targetBranch } : {}),
  };
}

async function changeDraftState(client: Octokit, nodeId: string | null, isDraft: boolean) {
  if (!nodeId) invalidResponse();
  const mutation = isDraft
    ? "mutation($pullRequestId: ID!) { convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { pullRequest { id } } }"
    : "mutation($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { id } } }";
  await client.graphql(mutation, { pullRequestId: nodeId });
}

function assertPullRequestIdentity(
  result: PullRequest,
  ref: Extract<PullRequestRef, { provider: "github" }>,
) {
  if (
    result.ref.provider !== "github" ||
    result.ref.number !== ref.number ||
    result.ref.owner.toLowerCase() !== ref.owner.toLowerCase() ||
    result.ref.repository.toLowerCase() !== ref.repository.toLowerCase()
  )
    invalidResponse();
}

function normalizePullRequest(
  data:
    | (GitHubListItem & { merged: boolean })
    | Awaited<ReturnType<Octokit["pulls"]["get"]>>["data"]
    | Awaited<ReturnType<Octokit["pulls"]["create"]>>["data"]
    | Awaited<ReturnType<Octokit["pulls"]["update"]>>["data"],
  ref?: PullRequestRef,
): PullRequest {
  if (!data.title || !data.html_url || !data.head?.ref || !data.base?.ref) invalidResponse();
  const state = data.merged
    ? "merged"
    : data.state === "open"
      ? "open"
      : data.state === "closed"
        ? "closed"
        : invalidResponse();

  return {
    ref: ref ?? {
      provider: "github",
      owner: data.base.repo?.owner?.login ?? "",
      repository: data.base.repo?.name ?? "",
      number: data.number,
    },
    url: data.html_url,
    title: data.title,
    body: data.body ?? "",
    state,
    isDraft: data.draft ?? false,
    sourceBranch: data.head.ref,
    targetBranch: data.base.ref,
  };
}

function githubRepository(repository: RepositoryRef) {
  if (repository.provider !== "github")
    throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub repository.");

  return repository;
}

function conclusion(value: string | null): PullRequestCheck["state"] {
  switch (value) {
    case "success":
      return "passed";
    case "failure":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "neutral":
      return "skipped";
    default:
      return "unknown";
  }
}
