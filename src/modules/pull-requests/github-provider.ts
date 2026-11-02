import { Octokit } from "@octokit/rest";
import { invalidResponse, providerRequest, ScmError } from "./errors";
import type {
  PullRequest,
  PullRequestCheck,
  PullRequestProvider,
  PullRequestRef,
  PullRequestReview,
  RepositoryRef,
} from "./provider";

export class GitHubApiProvider implements PullRequestProvider {
  constructor(private readonly client: Octokit) {}

  getPullRequest(ref: PullRequestRef): Promise<PullRequest> {
    return providerRequest(async () => {
      const { data } = await this.client.pulls.get(parameters(ref));
      if (!data.title || !data.html_url || !data.head?.ref || !data.base?.ref) invalidResponse();
      const state = data.merged
        ? "merged"
        : data.state === "open"
          ? "open"
          : data.state === "closed"
            ? "closed"
            : invalidResponse();

      return {
        ref,
        url: data.html_url,
        title: data.title,
        body: data.body ?? "",
        state,
        isDraft: data.draft ?? false,
        sourceBranch: data.head.ref,
        targetBranch: data.base.ref,
      };
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

  getChecks(ref: PullRequestRef): Promise<PullRequestCheck[]> {
    return providerRequest(async () => {
      const input = parameters(ref);
      const { data: pr } = await this.client.pulls.get(input);
      if (!pr.head?.sha) invalidResponse();
      const target = { owner: input.owner, repo: input.repo, ref: pr.head.sha, per_page: 100 };
      const [runs, statuses] = await Promise.all([
        this.client.paginate(this.client.checks.listForRef, { ...target, filter: "latest" }),
        this.client.paginate(this.client.repos.listCommitStatusesForRef, target),
      ]);
      const latest = new Map<string, (typeof statuses)[number]>();
      for (const status of statuses) {
        const existing = latest.get(status.context);
        if (!existing || status.id > existing.id) latest.set(status.context, status);
      }

      return [
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
    });
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

const reviewStates: Record<string, PullRequestReview["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
  DISMISSED: "pending",
};

function parameters(ref: PullRequestRef) {
  if (ref.provider !== "github")
    throw new ScmError("SCM_PROVIDER_MISMATCH", "Expected a GitHub PR reference.");

  return { owner: ref.owner, repo: ref.repository, pull_number: ref.number };
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
