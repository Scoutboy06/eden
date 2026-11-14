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
  PullRequestCommentThreadLister,
  PullRequestCommentThreadsQuery,
  PullRequestReviewer,
  PullRequestReviewInput,
  PullRequestMerger,
  PullRequestMergeInput,
  PullRequestMergeResult,
} from "../../modules/pull-requests/provider";
import { listReviewThreads } from "./review-threads";
import { readGitHubDiff } from "./diff";
import {
  assertPullRequestIdentity,
  normalizePullRequest,
  type GitHubListItem,
} from "./pull-request-normalization";

type GitHubCreatedComment =
  | Awaited<ReturnType<Octokit["issues"]["createComment"]>>["data"]
  | Awaited<ReturnType<Octokit["pulls"]["createReplyForReviewComment"]>>["data"];

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
        data = await providerRequest(async () => {
          if (replyId === undefined) {
            const response = await postDiscussionComment(this.client, ref, input.body);
            return response.data;
          }

          const response = await this.client.pulls.createReplyForReviewComment({
            ...parameters(ref),
            comment_id: replyId,
            body: input.body,
          });
          return response.data;
        });
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
      const requestedReviewers = [...reviewers, ...teams];
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
          throw reviewRequestFailure(requestedReviewers, error);
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
          throw reviewRequestFailure(requestedReviewers, error);
        }
      }

      return { requested: requestedReviewers, alreadyPending };
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
      const pullRequest = normalizePullRequest(data, ref);
      if (!options.raw) return pullRequest;

      return { ...pullRequest, raw: data };
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

      const comments: PullRequestComment[] = [];
      for (const comment of discussion) {
        let author: PullRequestComment["author"] = null;
        if (comment.user) author = { id: `user:${comment.user.id}`, name: comment.user.login };

        comments.push({
          id: `issue:${comment.id}`,
          body: comment.body ?? "",
          author,
          url: comment.html_url,
          createdAt: comment.created_at,
        });
      }

      for (const comment of inline) {
        let author: PullRequestComment["author"] = null;
        if (comment.user) author = { id: `user:${comment.user.id}`, name: comment.user.login };

        const normalized: PullRequestComment = {
          id: `review:${comment.id}`,
          body: comment.body,
          author,
          url: comment.html_url,
          createdAt: comment.created_at,
          path: comment.path,
          threadId: String(comment.in_reply_to_id ?? comment.id),
        };
        if (comment.line != null) normalized.line = comment.line;
        comments.push(normalized);
      }

      comments.sort((first, second) => {
        const firstCreatedAt = first.createdAt ?? "";
        const secondCreatedAt = second.createdAt ?? "";
        return firstCreatedAt.localeCompare(secondCreatedAt);
      });

      return comments;
    });
  }

  listCommentThreads(ref: PullRequestRef, query: PullRequestCommentThreadsQuery) {
    if (ref.provider !== "github")
      return Promise.reject(
        new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference."),
      );

    return listReviewThreads(this.client, ref, query);
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
      let event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      if (input.event === "approve") {
        event = "APPROVE";
      } else if (input.event === "request-changes") {
        event = "REQUEST_CHANGES";
      } else {
        event = "COMMENT";
      }
      const commitId = input.expectedHead ?? head;
      const reviewInput = {
        ...parameters(ref),
        commit_id: commitId,
        event,
        ...(input.body !== undefined ? { body: input.body } : {}),
      };
      let result;
      try {
        result = await providerRequest(() => this.client.pulls.createReview(reviewInput));
      } catch (error) {
        if (error instanceof ScmError && error.code !== "SCM_REQUEST_FAILED") throw error;
        throw new ScmError(
          "SCM_PARTIAL_FAILURE",
          `The review may have been submitted for head ${commitId}; inspect reviews before retrying.`,
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
        const isLatest = existing === undefined || status.id > existing.id;
        if (isLatest) latest.set(status.context, status);
      }

      const checks: PullRequestCheck[] = [];
      for (const run of runs) checks.push(normalizeCheckRun(run));
      for (const status of latest.values()) checks.push(normalizeCommitStatus(status));
      if (!options.requiredOnly) return checks;
      if (!pr.base?.ref) invalidResponse();
      const required = await this.requiredChecks(
        input.owner,
        input.repo,
        pr.base.ref,
        options.signal,
      );

      const requiredChecks: PullRequestCheck[] = [];
      for (const requirement of required) {
        const matches = checks.filter((check) => {
          if (check.name !== requirement.context) return false;
          const appliesToAnyApp = requirement.appId == null || requirement.appId === -1;
          if (appliesToAnyApp) return true;

          return runs.some(
            (run) => check.id === `check:${run.id}` && run.app?.id === requirement.appId,
          );
        });

        if (matches.length > 0) {
          requiredChecks.push(...matches);
          continue;
        }

        const appId = requirement.appId ?? "any";
        requiredChecks.push({
          id: `required:${requirement.context}:${appId}`,
          name: requirement.context,
          state: "pending",
        });
      }

      return requiredChecks;
    });
  }

  private async requiredChecks(owner: string, repo: string, branch: string, signal?: AbortSignal) {
    const target = { owner, repo, branch, request: { signal } };
    const [protection, rules] = await Promise.all([
      this.client.repos.getBranchProtection(target).catch((error: unknown) => {
        const isNotFound = responseStatus(error) === 404;
        if (isNotFound) return undefined;

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
    const hasWorkflowRules = rules.some((rule) => rule.type === "workflows");
    if (hasWorkflowRules)
      throw new ScmError(
        "SCM_UNSUPPORTED_OPERATION",
        "Required workflow rules cannot be projected as named status checks. Run without --required-only.",
      );
    const required = new Map<string, { context: string; appId?: number | null }>();
    const add = (context: string, appId?: number | null) => {
      const key = JSON.stringify([context, appId ?? -1]);
      required.set(key, { context, appId });
    };
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
        const isPending = review.state === "PENDING";
        if (!review.user || isPending) continue;
        const id = `user:${review.user.id}`;
        const state = reviewStates[review.state] ?? "unknown";
        const existing = latest.get(id);
        const preservesExistingDecision =
          state === "commented" && existing !== undefined && existing.state !== "commented";
        if (preservesExistingDecision) continue;
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

  const expectedHeadChanged = input.expectedHead && input.expectedHead !== head;
  if (expectedHeadChanged)
    throw new ScmError(
      "SCM_STALE_HEAD",
      "The PR head changed; inspect the new head before merging.",
    );
  const unsafeSourceBranch = input.deleteBranch && !isSafeSourceBranch(branch, base);
  if (unsafeSourceBranch)
    throw new ScmError(
      "SCM_INVALID_REFERENCE",
      "The PR source branch is not a safe distinct branch name.",
    );
  const sourceIsInRepository =
    sourceOwner.toLowerCase() === ref.owner.toLowerCase() &&
    sourceRepository.toLowerCase() === ref.repository.toLowerCase();
  const cannotDeleteForkBranch = input.deleteBranch && !sourceIsInRepository;
  if (cannotDeleteForkBranch)
    throw new ScmError(
      "SCM_UNSUPPORTED_OPERATION",
      "Automatic deletion is only supported for a source branch in this repository; fork branches are left unchanged.",
    );

  return { ref, parameters: params, head, branch, sourceOwner, sourceRepository };
}

function isSafeSourceBranch(branch: string, base: string) {
  const isDistinctFromBase = branch !== base;
  const hasSafeCharacters = /^[A-Za-z0-9._/-]+$/.test(branch);
  const hasNoTraversal = !branch.includes("..");
  return isDistinctFromBase && hasSafeCharacters && hasNoTraversal;
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

  if (typeof error.status !== "number") return;
  return error.status;
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
  const hasRestPatch = Object.keys(restPatch).length > 0;
  let updated = current;
  if (hasRestPatch) {
    const response = await client.pulls.update({ ...input, ...restPatch });
    updated = response.data;
  }

  const requestedDraftState = patch.isDraft;
  const draftStateMatches =
    requestedDraftState === undefined || requestedDraftState === (updated.draft ?? false);
  if (!draftStateMatches && requestedDraftState !== undefined) {
    updated = await updatePullRequestDraftState(
      client,
      input,
      updated,
      requestedDraftState,
      hasRestPatch,
    );
  }

  const result = normalizePullRequest(updated);
  assertPullRequestIdentity(result, ref);

  return result;
}

async function updatePullRequestDraftState(
  client: Octokit,
  input: ReturnType<typeof parameters>,
  current: Awaited<ReturnType<Octokit["pulls"]["get"]>>["data"],
  isDraft: boolean,
  hasRestPatch: boolean,
) {
  try {
    await providerRequest(() => changeDraftState(client, current.node_id, isDraft));
  } catch (error) {
    if (!hasRestPatch) throw error;
    const cause = safeFailureDetails(error);
    throw new ScmError(
      "SCM_PARTIAL_FAILURE",
      `Pull request fields were updated, but its draft state change failed. ${cause}`,
    );
  }

  try {
    const response = await providerRequest(() => client.pulls.get(input));
    return response.data;
  } catch (error) {
    throw new ScmError(
      "SCM_PARTIAL_FAILURE",
      `Pull request changes may have been applied, but confirmation failed. ${safeFailureDetails(error)}`,
    );
  }
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
  data: GitHubCreatedComment,
  ref: Extract<PullRequestRef, { provider: "github" }>,
  replyId: number | undefined,
): PullRequestComment {
  assertCreatedCommentResponse(data, ref, replyId);

  const commentKind = replyId === undefined ? "issue" : "review";
  let author: PullRequestComment["author"] = null;
  if (data.user) author = { id: `user:${data.user.id}`, name: data.user.login };

  const normalized: PullRequestComment = {
    id: `${commentKind}:${data.id}`,
    body: data.body,
    author,
    url: data.html_url,
    createdAt: data.created_at,
  };
  if (replyId !== undefined) normalized.threadId = String(replyId);

  return normalized;
}

function assertCreatedCommentResponse(
  data: GitHubCreatedComment,
  ref: Extract<PullRequestRef, { provider: "github" }>,
  replyId: number | undefined,
): asserts data is GitHubCreatedComment & { body: string } {
  const hasValidId = Number.isSafeInteger(data.id) && data.id >= 1;
  if (!hasValidId) invalidResponse();
  if (typeof data.body !== "string") invalidResponse();

  assertCommentLocation(data, ref);
  if (replyId === undefined) {
    assertDiscussionCommentTarget(data, ref);
    return;
  }

  assertReviewReplyTarget(data, ref, replyId);
}

function assertCommentLocation(
  data: GitHubCreatedComment,
  ref: Extract<PullRequestRef, { provider: "github" }>,
) {
  const url = new URL(data.html_url);
  const path = `/${ref.owner}/${ref.repository}/pull/${ref.number}`.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  const isPullRequestPage = pathname === path || pathname.startsWith(`${path}/`);
  const isGitHubPullRequestUrl = url.origin === "https://github.com" && isPullRequestPage;
  if (!isGitHubPullRequestUrl) invalidResponse();
}

function assertDiscussionCommentTarget(
  data: GitHubCreatedComment,
  ref: Extract<PullRequestRef, { provider: "github" }>,
) {
  if (!("issue_url" in data)) invalidResponse();
  const expectedIssueUrl =
    `https://api.github.com/repos/${ref.owner}/${ref.repository}/issues/${ref.number}`.toLowerCase();
  if (data.issue_url.toLowerCase() !== expectedIssueUrl) invalidResponse();
}

function assertReviewReplyTarget(
  data: GitHubCreatedComment,
  ref: Extract<PullRequestRef, { provider: "github" }>,
  replyId: number,
) {
  if (!("pull_request_url" in data)) invalidResponse();
  const hasExpectedPullRequest = samePrApiUrl(data.pull_request_url, ref);
  const hasExpectedReplyTarget = data.in_reply_to_id === replyId;
  if (!hasExpectedPullRequest || !hasExpectedReplyTarget) invalidResponse();
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
  const hasValidNumber = Number.isSafeInteger(data.number) && data.number >= 1;
  const hasValidState = data.state === "open" || data.state === "closed";
  const hasValidMergedAt = data.merged_at === null || typeof data.merged_at === "string";
  const hasValidAuthor = data.user == null || typeof data.user.login === "string";
  if (!hasValidNumber || !hasValidState || !hasValidMergedAt || !hasValidAuthor) invalidResponse();

  let author: PullRequestListItem["author"] = null;
  if (data.user) author = { id: `user:${data.user.id}`, name: data.user.login };

  return {
    ...normalizePullRequest({ ...data, merged: data.merged_at !== null }),
    author,
  };
}

function matchesListQuery(pr: PullRequestListItem, query: PullRequestListQuery): boolean {
  const stateDoesNotMatch = query.state !== "all" && pr.state !== query.state;
  if (stateDoesNotMatch) return false;

  const authorName = pr.author?.name.toLowerCase();
  const queryAuthor = query.author?.toLowerCase();
  const authorDoesNotMatch = query.author !== undefined && authorName !== queryAuthor;
  if (authorDoesNotMatch) return false;

  return query.draft === undefined || pr.isDraft === query.draft;
}

function safeFailureDetails(error: unknown): string {
  if (!(error instanceof ScmError)) return "The provider request failed.";
  return `${error.code}: ${error.message}`;
}

function reviewRequestFailure(reviewers: string[], error: unknown): ScmError {
  const requestedNames = reviewers.join(", ");
  const details = safeFailureDetails(error);
  const message = `Review requests may have been applied for ${requestedNames}; inspect pending reviewers before retrying. ${details}`;

  return new ScmError("SCM_PARTIAL_FAILURE", message);
}

function restFields(patch: PullRequestPatch) {
  const fields: { title?: string; body?: string; base?: string } = {};
  if (patch.title !== undefined) fields.title = patch.title;
  if (patch.body !== undefined) fields.body = patch.body;
  if (patch.targetBranch !== undefined) fields.base = patch.targetBranch;

  return fields;
}

async function changeDraftState(client: Octokit, nodeId: string | null, isDraft: boolean) {
  if (!nodeId) invalidResponse();
  let mutation: string;
  if (isDraft) {
    mutation =
      "mutation($pullRequestId: ID!) { convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { pullRequest { id } } }";
  } else {
    mutation =
      "mutation($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { id } } }";
  }

  await client.graphql(mutation, { pullRequestId: nodeId });
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

function normalizeCheckRun(
  run: Awaited<ReturnType<Octokit["checks"]["listForRef"]>>["data"]["check_runs"][number],
): PullRequestCheck {
  let state: PullRequestCheck["state"];
  if (run.status === "completed") {
    state = conclusion(run.conclusion);
  } else if (run.status === "in_progress") {
    state = "running";
  } else {
    state = "pending";
  }

  const check: PullRequestCheck = {
    id: `check:${run.id}`,
    name: run.name,
    state,
  };
  if (run.html_url) check.url = run.html_url;

  return check;
}

function normalizeCommitStatus(
  status: Awaited<ReturnType<Octokit["repos"]["listCommitStatusesForRef"]>>["data"][number],
): PullRequestCheck {
  let state: PullRequestCheck["state"];
  if (status.state === "success") {
    state = "passed";
  } else if (status.state === "pending") {
    state = "pending";
  } else if (status.state === "failure" || status.state === "error") {
    state = "failed";
  } else {
    state = "unknown";
  }

  const check: PullRequestCheck = {
    id: `status:${status.id}`,
    name: status.context,
    state,
  };
  if (status.target_url) check.url = status.target_url;

  return check;
}
