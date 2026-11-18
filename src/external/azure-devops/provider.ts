import type { IGitApi } from "azure-devops-node-api/GitApi";
import type { IPolicyApi } from "azure-devops-node-api/PolicyApi";
import { GitApi } from "azure-devops-node-api/GitApi";
import { PolicyApi } from "azure-devops-node-api/PolicyApi";
import { getBearerHandler, getPersonalAccessTokenHandler } from "azure-devops-node-api";
import {
  CommentType,
  PullRequestStatus,
  type GitPullRequest,
  type GitRepository,
} from "azure-devops-node-api/interfaces/GitInterfaces";
import { invalidResponse, providerRequest, ScmError } from "../../modules/pull-requests/errors";
import { confirmAzureDiffSnapshot, readAzurePullRequestDiff } from "./diff";
import { readAzureFileDiff } from "./file-diff";
import type { Credential } from "../../modules/pull-requests/credentials";
import type {
  PullRequest,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommenter,
  PullRequestCommentInput,
  PullRequestProvider,
  PullRequestCreateInput,
  PullRequestPatch,
  PullRequestRef,
  PullRequestWriter,
  PullRequestReopener,
  PullRequestReview,
  RepositoryRef,
  PullRequestListQuery,
  PullRequestListItem,
  PullRequestLister,
  PullRequestReviewRequester,
  PullRequestDiffer,
  PullRequestDiff,
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
  | "createPullRequestReviewer"
  | "getThreads"
  | "createThread"
  | "createComment"
  | "getPullRequestThread"
  | "getPullRequestIterations"
  | "getPullRequestIterationChanges"
  | "getItemContent"
>;
export type AzurePolicyClient = Pick<IPolicyApi, "getPolicyEvaluations">;

export class AzureDevOpsApiProvider
  implements
    PullRequestProvider,
    PullRequestWriter,
    PullRequestReopener,
    PullRequestLister,
    PullRequestReviewRequester,
    PullRequestCommenter,
    PullRequestDiffer
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

  closePullRequest(ref: PullRequestRef, options: { comment?: string } = {}): Promise<PullRequest> {
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
        throw new ScmError("SCM_INVALID_STATE", "A merged pull request cannot be closed.");
      if (normalized.state === "closed") return normalized;
      const updated = await providerRequest(() =>
        this.git.updatePullRequest(
          { status: PullRequestStatus.Abandoned },
          repository,
          id,
          project,
        ),
      ).catch((error: unknown) => {
        if (error instanceof ScmError && error.code !== "SCM_REQUEST_FAILED") throw error;
        throw possiblyApplied(
          error,
          "The pull request may have closed. Inspect the PR before retrying.",
        );
      });
      let result: PullRequest;
      try {
        assertKnownIdentity(updated, ref, repository, project);
        result = normalizeAzurePullRequest(updated, this.organizationUrl, ref, {
          repository,
          project,
        });
        if (result.state !== "closed") invalidResponse();
      } catch (error) {
        throw possiblyApplied(
          error,
          "The pull request may have closed, but its response could not be verified.",
        );
      }
      if (options.comment) {
        try {
          await this.addComment(ref, { body: options.comment });
        } catch (error) {
          throw new ScmError(
            "SCM_PARTIAL_FAILURE",
            `PR closed: ${result.url}; the closing comment could not be confirmed. Do not retry automatically; inspect the PR before adding a comment. ${error instanceof Error ? error.message : "Unknown provider error"}`,
          );
        }
      }
      return result;
    });
  }

  getPullRequest(ref: PullRequestRef, options: { raw?: boolean } = {}): Promise<PullRequest> {
    return providerRequest(async () => {
      const id = this.id(ref);
      if (ref.provider !== "azure-devops") invalidResponse();
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

  listPullRequests(query: PullRequestListQuery): Promise<PullRequestListItem[]> {
    return providerRequest(async () => {
      const repository = azureRepository(query.repository, this.organizationUrl);
      const resolved = await this.git.getRepository(repository.repository, repository.project);
      const identity = resolvedRepositoryIdentity(resolved);
      validateAzureListAuthor(query.author);
      const result: PullRequestListItem[] = [];
      for (let skip = 0; result.length < query.limit; skip += 100) {
        const page = await this.git.getPullRequests(
          identity.repositoryId,
          azureListCriteria(query),
          identity.projectId,
          undefined,
          skip,
          100,
        );
        for (const pr of page) {
          const item = normalizeListedPullRequest(pr, identity, this.organizationUrl);
          if (matchesAzureListQuery(item, query)) result.push(item);
          if (result.length >= query.limit) break;
        }
        if (page.length < 100) break;
      }
      return result;
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

  addComment(ref: PullRequestRef, input: PullRequestCommentInput): Promise<PullRequestComment> {
    return providerRequest(async () => {
      const id = this.id(ref);
      if (ref.provider !== "azure-devops") invalidResponse();
      const pr = await this.git.getPullRequestById(id);
      const { repository, project } = context(pr);
      assertKnownIdentity(pr, ref, repository, project);
      if (input.replyTo !== undefined) {
        const { threadId, parentCommentId } = azureReplyTarget(input.replyTo);
        const thread = await this.git.getPullRequestThread(repository, id, threadId, project);
        if (
          thread.id !== threadId ||
          thread.isDeleted ||
          !thread.comments?.some((item) => item.id === parentCommentId && !item.isDeleted)
        )
          throw new ScmError(
            "SCM_NOT_FOUND",
            "Reply target comment was not found on this pull request.",
          );
        const comment = await this.git.createComment(
          { content: input.body, parentCommentId, commentType: CommentType.Text },
          repository,
          id,
          threadId,
          project,
        );
        const posted = this.normalizePostedComment(threadId, comment, input.body);
        if (comment.parentCommentId !== undefined && comment.parentCommentId !== parentCommentId)
          throw possiblyApplied(
            undefined,
            "The comment may have been added, but its response could not be verified.",
          );
        return { ...posted, replyTo: `${threadId}:${comment.parentCommentId ?? parentCommentId}` };
      }
      const thread = await this.git.createThread(
        { comments: [{ content: input.body, commentType: CommentType.Text }] },
        repository,
        id,
        project,
      );
      let threadId: number;
      try {
        if (thread.id == null) invalidResponse();
        threadId = thread.id;
      } catch (error) {
        throw possiblyApplied(
          error,
          "The comment may have been added, but its response could not be verified.",
        );
      }
      const comment = thread.comments?.[0];
      if (!comment)
        throw possiblyApplied(
          undefined,
          "The comment may have been added, but its response could not be verified.",
        );
      return this.normalizePostedComment(threadId, comment, input.body);
    });
  }

  private normalizePostedComment(
    threadId: number,
    comment: Awaited<ReturnType<IGitApi["createComment"]>>,
    body: string,
  ): PullRequestComment {
    try {
      if (comment.id == null || comment.content !== body) invalidResponse();
      const result = normalizeComments([{ id: threadId, comments: [comment] }])[0];
      if (!result || result.id !== `${threadId}:${comment.id}`) invalidResponse();
      return result;
    } catch (error) {
      throw possiblyApplied(
        error,
        "The comment may have been added, but its response could not be verified.",
      );
    }
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

  requestReview(ref: PullRequestRef, input: { reviewers: string[]; teams: string[] }) {
    return providerRequest(async () => {
      if (input.teams.length)
        throw new ScmError(
          "SCM_UNSUPPORTED_OPERATION",
          "Azure DevOps does not support --team reviewer slugs; use Azure identity GUIDs with --reviewer.",
        );
      const reviewerIds = [
        ...new Set(input.reviewers.map((reviewerId) => reviewerId.toLowerCase())),
      ];
      for (const reviewerId of reviewerIds) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reviewerId))
          throw new ScmError("SCM_INVALID_OPTIONS", "Azure reviewer must be an identity GUID.");
      }
      const id = this.id(ref);
      if (ref.provider !== "azure-devops") invalidResponse();
      const pr = await this.git.getPullRequestById(id);
      const { repository, project } = context(pr);
      assertKnownIdentity(pr, ref, repository, project);
      const current = await this.git.getPullRequestReviewers(repository, id, project);
      const existingIds = new Set(
        current.map((reviewer) => reviewer.id?.toLowerCase()).filter(Boolean),
      );
      const requested: string[] = [];
      const alreadyPending: string[] = [];
      for (const reviewerId of reviewerIds) {
        if (existingIds.has(reviewerId.toLowerCase())) {
          alreadyPending.push(reviewerId);
          continue;
        }
        try {
          const created = await this.git.createPullRequestReviewer(
            {},
            repository,
            id,
            reviewerId,
            project,
          );
          if (created.id?.toLowerCase() !== reviewerId.toLowerCase()) invalidResponse();
        } catch {
          throw new ScmError(
            "SCM_PARTIAL_FAILURE",
            `Review requests may have been applied for ${[...requested, reviewerId].join(", ")}; inspect the PR reviewers before retrying.`,
          );
        }
        requested.push(reviewerId);
      }
      return { requested, alreadyPending };
    });
  }

  getDiff(ref: PullRequestRef): Promise<PullRequestDiff> {
    return providerRequest(async () => {
      const id = this.id(ref);
      const { snapshot, changes } = await readAzurePullRequestDiff(this.git, id);
      const files = [];
      for (const change of changes) files.push(await readAzureFileDiff(this.git, snapshot, change));
      await confirmAzureDiffSnapshot(this.git, snapshot);
      const unavailableCounts = files.some((file) => file.patch.status === "unavailable");

      return {
        ref,
        baseCommit: snapshot.commonCommit,
        headCommit: snapshot.sourceCommit,
        files,
        completeness: unavailableCounts
          ? {
              status: "incomplete",
              reason:
                "Line counts are unavailable for binary or oversized files; zero counts for those files are placeholders.",
            }
          : { status: "complete" },
      };
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

function resolvedRepositoryIdentity(repository: GitRepository) {
  return {
    repositoryId: repository.id ?? invalidResponse(),
    projectId: repository.project?.id ?? invalidResponse(),
    repository: repository.name ?? invalidResponse(),
    project: repository.project?.name ?? invalidResponse(),
  };
}

function validateAzureListAuthor(author: string | undefined): void {
  if (author !== undefined && !isAzureIdentityGuid(author))
    throw new ScmError("SCM_INVALID_OPTIONS", "--author must be an Azure DevOps identity GUID.");
}

function azureListCriteria(query: PullRequestListQuery) {
  const status = {
    open: PullRequestStatus.Active,
    closed: PullRequestStatus.Abandoned,
    merged: PullRequestStatus.Completed,
    all: PullRequestStatus.All,
  }[query.state];
  return { status, ...(query.author !== undefined ? { creatorId: query.author } : {}) };
}

function normalizeListedPullRequest(
  pr: GitPullRequest,
  repository: ReturnType<typeof resolvedRepositoryIdentity>,
  organizationUrl: string,
): PullRequestListItem {
  if (
    !sameAzureIdentity(pr.repository?.id, repository.repositoryId) ||
    !sameAzureIdentity(pr.repository?.project?.id, repository.projectId)
  )
    invalidResponse();
  const identity = pr.createdBy;
  if (identity && (!identity.id || !isAzureIdentityGuid(identity.id) || !identity.displayName))
    invalidResponse();
  const ref: PullRequestRef = {
    provider: "azure-devops",
    organizationUrl,
    id: pr.pullRequestId ?? invalidResponse(),
  };
  const item = normalizeAzurePullRequest(pr, organizationUrl, ref, repository);
  return {
    ...item,
    author: identity ? { id: identity.id!, name: identity.displayName! } : null,
  };
}

function matchesAzureListQuery(item: PullRequestListItem, query: PullRequestListQuery): boolean {
  return (
    (query.state === "all" || item.state === query.state) &&
    (query.draft === undefined || query.draft === item.isDraft)
  );
}

function isAzureIdentityGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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

function azureReplyTarget(selector: string): { threadId: number; parentCommentId: number } {
  const match = /^azure:([1-9][0-9]*):([1-9][0-9]*)$/.exec(selector);
  if (!match)
    throw new ScmError("SCM_INVALID_OPTIONS", "Reply target must be an Azure comment ID.");
  const threadId = Number(match[1]);
  const parentCommentId = Number(match[2]);
  if (!Number.isSafeInteger(threadId) || !Number.isSafeInteger(parentCommentId))
    throw new ScmError("SCM_INVALID_OPTIONS", "Reply target must use safe Azure comment IDs.");

  return { threadId, parentCommentId };
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
