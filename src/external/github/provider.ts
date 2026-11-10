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
} from "../../modules/pull-requests/provider";

type GitHubListItem = Awaited<ReturnType<Octokit["pulls"]["list"]>>["data"][number];

export class GitHubApiProvider
  implements
    PullRequestProvider,
    PullRequestWriter,
    PullRequestReopener,
    PullRequestLister,
    PullRequestCloser,
    PullRequestCommenter
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
