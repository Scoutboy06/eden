import {
  CommentThreadStatus,
  CommentType,
  GitStatusState,
  PullRequestStatus,
  type GitPullRequest,
} from "azure-devops-node-api/interfaces/GitInterfaces";
import type { IGitApi } from "azure-devops-node-api/GitApi";
import type { IPolicyApi } from "azure-devops-node-api/PolicyApi";
import { PolicyEvaluationStatus } from "azure-devops-node-api/interfaces/PolicyInterfaces";
import { invalidResponse } from "../../modules/pull-requests/errors";
import type {
  PullRequest,
  PullRequestCheck,
  PullRequestComment,
  PullRequestRef,
  PullRequestReview,
} from "../../modules/pull-requests/provider";

type AzurePolicyEvaluation = Awaited<ReturnType<IPolicyApi["getPolicyEvaluations"]>>[number];
type AzureStatus = Awaited<ReturnType<IGitApi["getPullRequestStatuses"]>>[number];
type AzureCommentThread = Awaited<ReturnType<IGitApi["getThreads"]>>[number];

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

export function context(pr: GitPullRequest): { repository: string; project: string } {
  return {
    repository: pr.repository?.id ?? invalidResponse(),
    project: pr.repository?.project?.name ?? invalidResponse(),
  };
}

export function normalizeAzurePullRequest(
  pr: GitPullRequest,
  organizationUrl: string,
  ref: PullRequestRef,
  identity: { repository: string; project: string },
  includeRaw = false,
): PullRequest {
  const state = normalizePullRequestState(pr.status);
  if (!pr.title || !pr.sourceRefName || !pr.targetRefName || !pr.pullRequestId) invalidResponse();

  const project = encodeURIComponent(identity.project);
  const repository = encodeURIComponent(identity.repository);
  const url = `${organizationUrl}/${project}/_git/${repository}/pullrequest/${pr.pullRequestId}`;

  return {
    ref,
    url,
    title: pr.title,
    body: pr.description ?? "",
    state,
    isDraft: pr.isDraft ?? false,
    sourceBranch: shortBranch(pr.sourceRefName),
    targetBranch: shortBranch(pr.targetRefName),
    ...(includeRaw ? { raw: pr } : {}),
  };
}

export function assertKnownIdentity(
  pr: GitPullRequest,
  ref: Extract<PullRequestRef, { provider: "azure-devops" }>,
  repository: string,
  project: string,
): void {
  if (
    pr.pullRequestId !== ref.id ||
    !sameAzureIdentity(pr.repository?.id, repository) ||
    !sameAzureIdentity(pr.repository?.project?.name, project)
  )
    invalidResponse();
}

export function normalizeChecks(
  statuses: AzureStatus[],
  evaluations: AzurePolicyEvaluation[],
  requiredOnly?: boolean,
): PullRequestCheck[] {
  const latest = new Map<string, AzureStatus>();
  for (const status of statuses) {
    const key = JSON.stringify([status.context?.genre, status.context?.name]);
    const previous = latest.get(key);
    if (!previous || (status.id ?? 0) > (previous.id ?? 0)) latest.set(key, status);
  }

  const statusChecks = [...latest.values()].map(normalizeStatusCheck);
  const policyChecks = evaluations
    .filter((evaluation) => isIncludedPolicy(evaluation, requiredOnly))
    .map(normalizePolicyCheck);

  return [...statusChecks, ...policyChecks];
}

export function normalizeReviewState(vote: number | undefined): PullRequestReview["state"] {
  return reviewStates[vote ?? 0] ?? "unknown";
}

export function normalizeComments(threads: AzureCommentThread[]): PullRequestComment[] {
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
              name: comment.author.displayName ?? comment.author.uniqueName ?? invalidResponse(),
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
}

export function isSupportedPolicy(evaluation: AzurePolicyEvaluation): boolean {
  const policyType = evaluation.configuration?.type?.id?.toLowerCase() ?? "";
  return [buildPolicyType, statusPolicyType].includes(policyType);
}

export function sameAzureIdentity(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();
}

function normalizePullRequestState(status: PullRequestStatus | undefined): PullRequest["state"] {
  switch (status) {
    case PullRequestStatus.Active:
      return "open";
    case PullRequestStatus.Abandoned:
      return "closed";
    case PullRequestStatus.Completed:
      return "merged";
    default:
      return invalidResponse();
  }
}

function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function normalizeStatusCheck(status: AzureStatus): PullRequestCheck {
  return {
    id: `status:${status.id ?? invalidResponse()}`,
    name: status.context?.name ?? invalidResponse(),
    ...(status.targetUrl ? { url: status.targetUrl } : {}),
    state: statusStates[status.state ?? -1] ?? "unknown",
  };
}

function isIncludedPolicy(evaluation: AzurePolicyEvaluation, requiredOnly?: boolean): boolean {
  if (requiredOnly) {
    return (
      evaluation.configuration?.isBlocking === true && evaluation.configuration.isEnabled === true
    );
  }

  return evaluation.configuration?.type?.id?.toLowerCase() === buildPolicyType;
}

function normalizePolicyCheck(evaluation: AzurePolicyEvaluation): PullRequestCheck {
  const policyType = evaluation.configuration?.type?.id?.toLowerCase();
  const kind = policyType === buildPolicyType ? "build" : "policy";
  const id = evaluation.evaluationId ?? invalidResponse();
  const name =
    evaluation.configuration?.settings?.displayName ??
    evaluation.configuration?.settings?.statusName ??
    "Build validation";
  const state = policyStates[evaluation.status ?? -1] ?? "unknown";

  return { id: `${kind}:${id}`, name, state };
}
