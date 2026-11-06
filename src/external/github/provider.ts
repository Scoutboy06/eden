import { Octokit } from "@octokit/rest";
import { invalidResponse, providerRequest, ScmError } from "../../modules/pull-requests/errors";
import type { Credential } from "../../modules/pull-requests/credentials";
import type {
  PullRequest,
  PullRequestCheck,
  PullRequestComment,
  PullRequestProvider,
  PullRequestCreateInput,
  PullRequestPatch,
  PullRequestRef,
  PullRequestWriter,
  PullRequestReview,
  RepositoryRef,
} from "../../modules/pull-requests/provider";

export class GitHubApiProvider implements PullRequestProvider, PullRequestWriter {
  constructor(private readonly client: Octokit) {}

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
      return normalizePullRequest(data, {
        ...input.repository,
        number: data.number,
      });
    });
  }

  editPullRequest(ref: PullRequestRef, patch: PullRequestPatch): Promise<PullRequest> {
    return providerRequest(() => editPullRequest(this.client, ref, patch));
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
    result.ref.owner !== ref.owner ||
    result.ref.repository !== ref.repository
  )
    invalidResponse();
}

function normalizePullRequest(
  data:
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
