import type { IGitApi } from "azure-devops-node-api/GitApi";
import type { IPolicyApi } from "azure-devops-node-api/PolicyApi";
import { GitApi } from "azure-devops-node-api/GitApi";
import { PolicyApi } from "azure-devops-node-api/PolicyApi";
import { getBearerHandler, getPersonalAccessTokenHandler } from "azure-devops-node-api";
import {
  GitStatusState,
  CommentThreadStatus,
  CommentType,
  PullRequestStatus,
  type GitPullRequest,
} from "azure-devops-node-api/interfaces/GitInterfaces";
import { PolicyEvaluationStatus } from "azure-devops-node-api/interfaces/PolicyInterfaces";
import { invalidResponse, providerRequest, ScmError } from "../../modules/pull-requests/errors";
import type { Credential } from "../../modules/pull-requests/credentials";
import type {
  PullRequest,
  PullRequestCheck,
  PullRequestComment,
  PullRequestProvider,
  PullRequestRef,
  PullRequestReview,
  RepositoryRef,
} from "../../modules/pull-requests/provider";

export type AzureGitClient = Pick<
  IGitApi,
  | "getPullRequestById"
  | "getPullRequests"
  | "getPullRequestStatuses"
  | "getPullRequestReviewers"
  | "getThreads"
>;
export type AzurePolicyClient = Pick<IPolicyApi, "getPolicyEvaluations">;

export class AzureDevOpsApiProvider implements PullRequestProvider {
  constructor(
    private readonly organizationUrl: string,
    private readonly git: AzureGitClient,
    private readonly policies: AzurePolicyClient,
  ) {}

  getPullRequest(ref: PullRequestRef, options: { raw?: boolean } = {}): Promise<PullRequest> {
    return providerRequest(async () => {
      const pr = await this.git.getPullRequestById(this.id(ref));
      const { repository, project } = context(pr);
      const state =
        pr.status === PullRequestStatus.Active
          ? "open"
          : pr.status === PullRequestStatus.Abandoned
            ? "closed"
            : pr.status === PullRequestStatus.Completed
              ? "merged"
              : invalidResponse();
      if (!pr.title || !pr.sourceRefName || !pr.targetRefName) invalidResponse();

      return {
        ref,
        url: `${this.organizationUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${this.id(ref)}`,
        title: pr.title,
        body: pr.description ?? "",
        state,
        isDraft: pr.isDraft ?? false,
        sourceBranch: shortBranch(pr.sourceRefName),
        targetBranch: shortBranch(pr.targetRefName),
        ...(options.raw ? { raw: pr } : {}),
      };
    });
  }

  getComments(ref: PullRequestRef): Promise<PullRequestComment[]> {
    return providerRequest(async () => {
      const id = this.id(ref);
      const pr = await this.git.getPullRequestById(id);
      const { repository, project } = context(pr);
      const threads = await this.git.getThreads(repository, id, project);

      return threads.flatMap((thread) => {
        if (thread.isDeleted) return [];

        return (thread.comments ?? [])
          .filter((comment) => !comment.isDeleted && comment.commentType === CommentType.Text)
          .map((comment): PullRequestComment => ({
            id: `${thread.id ?? invalidResponse()}:${comment.id ?? invalidResponse()}`,
            body: comment.content ?? "",
            author: comment.author
              ? {
                  id: comment.author.id ?? invalidResponse(),
                  name:
                    comment.author.displayName ?? comment.author.uniqueName ?? invalidResponse(),
                }
              : null,
            ...(comment.publishedDate ? { createdAt: comment.publishedDate.toISOString() } : {}),
            ...(thread.threadContext?.filePath ? { path: thread.threadContext.filePath } : {}),
            ...(thread.threadContext?.rightFileStart?.line != null
              ? { line: thread.threadContext.rightFileStart.line }
              : {}),
            threadId: String(thread.id),
            ...(thread.status != null
              ? {
                  isResolved:
                    thread.status !== CommentThreadStatus.Active &&
                    thread.status !== CommentThreadStatus.Unknown,
                }
              : {}),
          }));
      });
    });
  }

  findOpenPullRequests(query: {
    repository: RepositoryRef;
    sourceBranch: string;
  }): Promise<PullRequestRef[]> {
    return providerRequest(async () => {
      const repository = query.repository;
      if (
        repository.provider !== "azure-devops" ||
        repository.organizationUrl.toLowerCase() !== this.organizationUrl.toLowerCase()
      )
        throw new ScmError(
          "SCM_PROVIDER_MISMATCH",
          "Expected a repository in the selected Azure organization.",
        );

      const result: PullRequestRef[] = [];
      for (let skip = 0; ; skip += 100) {
        const page = await this.git.getPullRequests(
          repository.repository,
          {
            status: PullRequestStatus.Active,
            sourceRefName: `refs/heads/${query.sourceBranch}`,
          },
          repository.project,
          undefined,
          skip,
          100,
        );
        for (const pr of page) {
          if (!pr.pullRequestId) invalidResponse();
          result.push({
            provider: "azure-devops",
            organizationUrl: this.organizationUrl,
            id: pr.pullRequestId,
          });
        }
        if (page.length < 100) return result;
      }
    });
  }

  getChecks(ref: PullRequestRef): Promise<PullRequestCheck[]> {
    return providerRequest(async () => {
      const id = this.id(ref);
      const pr = await this.git.getPullRequestById(id);
      const { repository, project } = context(pr);
      const projectId = pr.repository?.project?.id ?? invalidResponse();
      const [statuses, evaluations] = await Promise.all([
        this.git.getPullRequestStatuses(repository, id, project),
        this.buildPolicies(projectId, id),
      ]);
      const latest = new Map<string, (typeof statuses)[number]>();
      for (const status of statuses) {
        const key = JSON.stringify([status.context?.genre, status.context?.name]);
        const previous = latest.get(key);
        if (!previous || (status.id ?? 0) > (previous.id ?? 0)) latest.set(key, status);
      }

      return [
        ...[...latest.values()].map((status): PullRequestCheck => ({
          id: `status:${status.id ?? invalidResponse()}`,
          name: status.context?.name ?? invalidResponse(),
          ...(status.targetUrl ? { url: status.targetUrl } : {}),
          state: statusStates[status.state ?? -1] ?? "unknown",
        })),
        ...evaluations.map((evaluation): PullRequestCheck => ({
          id: `build:${evaluation.evaluationId ?? invalidResponse()}`,
          name: evaluation.configuration?.settings?.displayName ?? "Build validation",
          state: policyStates[evaluation.status ?? -1] ?? "unknown",
        })),
      ];
    });
  }

  getReviews(ref: PullRequestRef): Promise<PullRequestReview[]> {
    return providerRequest(async () => {
      const id = this.id(ref);
      const pr = await this.git.getPullRequestById(id);
      const { repository, project } = context(pr);
      const reviewers = await this.git.getPullRequestReviewers(repository, id, project);

      return reviewers.map((reviewer) => ({
        reviewer: {
          id: reviewer.id ?? invalidResponse(),
          name: reviewer.displayName ?? reviewer.uniqueName ?? invalidResponse(),
        },
        state: reviewStates[reviewer.vote ?? 0] ?? "unknown",
      }));
    });
  }

  private id(ref: PullRequestRef): number {
    if (
      ref.provider !== "azure-devops" ||
      ref.organizationUrl.toLowerCase() !== this.organizationUrl.toLowerCase()
    )
      throw new ScmError(
        "SCM_PROVIDER_MISMATCH",
        "Expected a PR in the selected Azure organization.",
      );

    return ref.id;
  }

  private async buildPolicies(projectId: string, id: number) {
    const result = [];
    for (let skip = 0; ; skip += 100) {
      const page = await this.policies.getPolicyEvaluations(
        projectId,
        `vstfs:///CodeReview/CodeReviewId/${projectId}/${id}`,
        false,
        100,
        skip,
      );
      result.push(
        ...page.filter(
          (evaluation) =>
            evaluation.configuration?.type?.id?.toLowerCase() ===
            "0609b952-1397-4640-95ec-e00a01b2c241",
        ),
      );
      if (page.length < 100) return result;
    }
  }
}

export function createAzureDevOpsApiProvider(
  organizationUrl: string,
  credential?: Credential,
): AzureDevOpsApiProvider {
  const handlers = credential
    ? [
        credential.kind === "pat"
          ? getPersonalAccessTokenHandler(credential.token)
          : getBearerHandler(credential.token),
      ]
    : [];
  const options = { socketTimeout: 30_000, allowRedirects: false, maxRetries: 0 };

  return new AzureDevOpsApiProvider(
    organizationUrl,
    new GitApi(organizationUrl, handlers, options),
    new PolicyApi(organizationUrl, handlers, options),
  );
}

const statusStates: Record<number, PullRequestCheck["state"]> = {
  [GitStatusState.Succeeded]: "passed",
  [GitStatusState.Pending]: "pending",
  [GitStatusState.Failed]: "failed",
  [GitStatusState.Error]: "failed",
  [GitStatusState.NotApplicable]: "skipped",
};

const policyStates: Record<number, PullRequestCheck["state"]> = {
  [PolicyEvaluationStatus.Approved]: "passed",
  [PolicyEvaluationStatus.Rejected]: "failed",
  [PolicyEvaluationStatus.Broken]: "failed",
  [PolicyEvaluationStatus.Queued]: "pending",
  [PolicyEvaluationStatus.Running]: "running",
  [PolicyEvaluationStatus.NotApplicable]: "skipped",
};

const reviewStates: Record<number, PullRequestReview["state"]> = {
  10: "approved",
  5: "approved-with-suggestions",
  0: "pending",
  [-5]: "changes-requested",
  [-10]: "rejected",
};

function context(pr: GitPullRequest): { repository: string; project: string } {
  return {
    repository: pr.repository?.id ?? invalidResponse(),
    project: pr.repository?.project?.name ?? invalidResponse(),
  };
}

function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}
