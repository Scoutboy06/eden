import type { IGitApi } from "azure-devops-node-api/GitApi";
import type { IPolicyApi } from "azure-devops-node-api/PolicyApi";
import { GitApi } from "azure-devops-node-api/GitApi";
import { PolicyApi } from "azure-devops-node-api/PolicyApi";
import { getBearerHandler, getPersonalAccessTokenHandler } from "azure-devops-node-api";
import {
  PullRequestStatus,
  type GitPullRequest,
} from "azure-devops-node-api/interfaces/GitInterfaces";
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
  PullRequestReopener,
  PullRequestReview,
  RepositoryRef,
} from "../../modules/pull-requests/provider";
import {
  assertKnownIdentity,
  context,
  normalizeAzurePullRequest,
  normalizeChecks,
  normalizeComments,
  normalizeReviewState,
  sameAzureIdentity,
  isSupportedPolicy,
} from "./normalize";

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

export class AzureDevOpsApiProvider
  implements PullRequestProvider, PullRequestWriter, PullRequestReopener
{
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

  reopenPullRequest(ref: PullRequestRef): Promise<PullRequest> {
    return providerRequest(async () => {
      const id = this.id(ref);
      if (ref.provider !== "azure-devops") invalidResponse();
      const current = await this.git.getPullRequestById(id);
      const { repository, project } = context(current);
      assertKnownIdentity(current, ref, repository, project);
      const normalized = normalizeAzurePullRequest(current, this.organizationUrl, ref, {
        repository,
        project,
      });
      if (normalized.state === "merged")
        throw new ScmError("SCM_INVALID_STATE", "A merged pull request cannot be reopened.");
      if (normalized.state === "open") return normalized;
      const updated = await this.git.updatePullRequest(
        { status: PullRequestStatus.Active },
        repository,
        id,
        project,
      );
      try {
        assertKnownIdentity(updated, ref, repository, project);
        const result = normalizeAzurePullRequest(updated, this.organizationUrl, ref, {
          repository,
          project,
        });
        if (result.state !== "open") invalidResponse();

        return result;
      } catch (error) {
        throw possiblyApplied(
          error,
          "The pull request may have reopened, but its response could not be verified.",
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

      return normalizeComments(threads);
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
      return normalizeChecks(statuses, evaluations, options.requiredOnly);
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
        state: normalizeReviewState(reviewer.vote),
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
      result.push(...page.filter(isSupportedPolicy));
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

function fullBranch(branch: string) {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

function possiblyApplied(error: unknown, message: string): ScmError {
  return new ScmError(
    "SCM_PARTIAL_FAILURE",
    `${message} ${error instanceof ScmError ? `${error.code}: ${error.message}` : "The provider returned an invalid response."}`,
  );
}
