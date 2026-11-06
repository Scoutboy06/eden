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
  PullRequestCreateInput,
  PullRequestPatch,
  PullRequestRef,
  PullRequestWriter,
  PullRequestReview,
  RepositoryRef,
} from "../../modules/pull-requests/provider";

export type AzureGitClient = Pick<
  IGitApi,
  | "getPullRequestById"
  | "createPullRequest"
  | "updatePullRequest"
  | "getRepository"
  | "getPullRequests"
  | "getPullRequestStatuses"
  | "getPullRequestReviewers"
  | "getThreads"
>;
export type AzurePolicyClient = Pick<IPolicyApi, "getPolicyEvaluations">;

export class AzureDevOpsApiProvider implements PullRequestProvider, PullRequestWriter {
  constructor(
    private readonly organizationUrl: string,
    private readonly git: AzureGitClient,
    private readonly policies: AzurePolicyClient,
  ) {}

  createPullRequest(input: PullRequestCreateInput): Promise<PullRequest> {
    return providerRequest(async () => {
      const repository = azureRepository(input.repository, this.organizationUrl);
      const resolved = await this.git.getRepository(repository.repository, repository.project);
      const repositoryId = resolved.id ?? invalidResponse();
      const projectId = resolved.project?.id ?? invalidResponse();
      if (!resolved.name || !resolved.project?.name) invalidResponse();
      const created = await this.git.createPullRequest(
        {
          title: input.title,
          description: input.body,
          sourceRefName: fullBranch(input.sourceBranch),
          targetRefName: fullBranch(input.targetBranch),
          isDraft: input.draft,
        },
        repositoryId,
        projectId,
      );
      try {
        if (
          !sameAzureIdentity(created.repository?.id, repositoryId) ||
          !sameAzureIdentity(created.repository?.project?.id, projectId)
        )
          invalidResponse();
        return normalizeAzurePullRequest(
          created,
          this.organizationUrl,
          {
            id: created.pullRequestId ?? invalidResponse(),
            provider: "azure-devops",
            organizationUrl: this.organizationUrl,
          },
          { repository: resolved.name, project: resolved.project.name },
        );
      } catch (error) {
        throw possiblyApplied(
          error,
          "Pull request creation may have succeeded, but its response could not be verified.",
        );
      }
    });
  }

  editPullRequest(ref: PullRequestRef, patch: PullRequestPatch): Promise<PullRequest> {
    return providerRequest(async () => {
      if (ref.provider !== "azure-devops")
        throw new ScmError(
          "SCM_PROVIDER_MISMATCH",
          "Expected a PR in the selected Azure organization.",
        );
      const id = this.id(ref);
      const current = await this.git.getPullRequestById(id);
      const { repository, project } = context(current);
      assertKnownIdentity(current, ref, repository, project);
      const update: GitPullRequest = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { description: patch.body } : {}),
        ...(patch.targetBranch !== undefined
          ? { targetRefName: fullBranch(patch.targetBranch) }
          : {}),
        ...(patch.isDraft !== undefined ? { isDraft: patch.isDraft } : {}),
      };
      const updated = await this.git.updatePullRequest(update, repository, id, project);
      try {
        assertKnownIdentity(updated, ref, repository, project);
        return normalizeAzurePullRequest(updated, this.organizationUrl, ref, {
          repository,
          project,
        });
      } catch (error) {
        throw possiblyApplied(
          error,
          "Pull request changes may have been applied, but its response could not be verified.",
        );
      }
    });
  }

  getPullRequest(ref: PullRequestRef, options: { raw?: boolean } = {}): Promise<PullRequest> {
    return providerRequest(async () => {
      const id = this.id(ref);
      const pr = await this.git.getPullRequestById(id);
      const { repository, project } = context(pr);
      return normalizeAzurePullRequest(
        pr,
        this.organizationUrl,
        ref,
        { repository, project },
        options.raw,
      );
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

  getChecks(
    ref: PullRequestRef,
    options: { requiredOnly?: boolean } = {},
  ): Promise<PullRequestCheck[]> {
    return providerRequest(async () => {
      const id = this.id(ref);
      const pr = await this.git.getPullRequestById(id);
      const { repository, project } = context(pr);
      const projectId = pr.repository?.project?.id ?? invalidResponse();
      const [statuses, evaluations] = await Promise.all([
        options.requiredOnly ? [] : this.git.getPullRequestStatuses(repository, id, project),
        this.checkPolicies(projectId, id),
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
        ...evaluations
          .filter((evaluation) =>
            options.requiredOnly
              ? evaluation.configuration?.isBlocking === true &&
                evaluation.configuration.isEnabled === true
              : evaluation.configuration?.type?.id?.toLowerCase() === buildPolicyType,
          )
          .map((evaluation): PullRequestCheck => ({
            id: `${evaluation.configuration?.type?.id?.toLowerCase() === buildPolicyType ? "build" : "policy"}:${evaluation.evaluationId ?? invalidResponse()}`,
            name:
              evaluation.configuration?.settings?.displayName ??
              evaluation.configuration?.settings?.statusName ??
              "Build validation",
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

  private async checkPolicies(projectId: string, id: number) {
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
        ...page.filter((evaluation) =>
          [buildPolicyType, statusPolicyType].includes(
            evaluation.configuration?.type?.id?.toLowerCase() ?? "",
          ),
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

const buildPolicyType = "0609b952-1397-4640-95ec-e00a01b2c241";
const statusPolicyType = "c2a1889d-b943-4856-b76f-9e46bb6b0df2";

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

function azureRepository(repository: RepositoryRef, organizationUrl: string) {
  if (
    repository.provider !== "azure-devops" ||
    repository.organizationUrl.toLowerCase() !== organizationUrl.toLowerCase()
  )
    throw new ScmError(
      "SCM_PROVIDER_MISMATCH",
      "Expected a repository in the selected Azure organization.",
    );
  return repository;
}

function normalizeAzurePullRequest(
  pr: GitPullRequest,
  organizationUrl: string,
  ref: PullRequestRef,
  identity: { repository: string; project: string },
  includeRaw = false,
): PullRequest {
  const state =
    pr.status === PullRequestStatus.Active
      ? "open"
      : pr.status === PullRequestStatus.Abandoned
        ? "closed"
        : pr.status === PullRequestStatus.Completed
          ? "merged"
          : invalidResponse();
  if (!pr.title || !pr.sourceRefName || !pr.targetRefName || !pr.pullRequestId) invalidResponse();
  return {
    ref,
    url: `${organizationUrl}/${encodeURIComponent(identity.project)}/_git/${encodeURIComponent(identity.repository)}/pullrequest/${pr.pullRequestId}`,
    title: pr.title,
    body: pr.description ?? "",
    state,
    isDraft: pr.isDraft ?? false,
    sourceBranch: shortBranch(pr.sourceRefName),
    targetBranch: shortBranch(pr.targetRefName),
    ...(includeRaw ? { raw: pr } : {}),
  };
}

function assertKnownIdentity(
  pr: GitPullRequest,
  ref: Extract<PullRequestRef, { provider: "azure-devops" }>,
  repository: string,
  project: string,
) {
  if (
    pr.pullRequestId !== ref.id ||
    !sameAzureIdentity(pr.repository?.id, repository) ||
    !sameAzureIdentity(pr.repository?.project?.name, project)
  )
    invalidResponse();
}

function fullBranch(branch: string) {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

function possiblyApplied(error: unknown, message: string): ScmError {
  return new ScmError(
    "SCM_PARTIAL_FAILURE",
    `${message} ${error instanceof ScmError ? `${error.code}: ${error.message}` : "The provider returned an invalid response."}`,
  );
}

function sameAzureIdentity(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();
}

function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}
