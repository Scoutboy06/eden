export type RepositoryRef =
  | { provider: "github"; owner: string; repository: string }
  | {
      provider: "azure-devops";
      organizationUrl: string;
      project: string;
      repository: string;
    };

export type PullRequestRef =
  | { provider: "github"; owner: string; repository: string; number: number }
  | { provider: "azure-devops"; organizationUrl: string; id: number };

export interface PullRequest {
  ref: PullRequestRef;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  sourceBranch: string;
  targetBranch: string;
  raw?: unknown;
  comments?: PullRequestComment[];
  checks?: PullRequestCheck[];
}

export interface PullRequestComment {
  id: string;
  body: string;
  author: { id: string; name: string } | null;
  url?: string;
  createdAt?: string;
  path?: string;
  line?: number;
  threadId?: string;
  replyTo?: string;
  isResolved?: boolean;
}

export interface PullRequestCheck {
  id: string;
  name: string;
  url?: string;
  state: "pending" | "running" | "passed" | "failed" | "cancelled" | "skipped" | "unknown";
}

export interface PullRequestReview {
  reviewer: { id: string; name: string };
  state:
    | "pending"
    | "approved"
    | "approved-with-suggestions"
    | "changes-requested"
    | "rejected"
    | "commented"
    | "dismissed"
    | "unknown";
}

export interface PullRequestProvider {
  getPullRequest(ref: PullRequestRef, options?: { raw?: boolean }): Promise<PullRequest>;
  getComments(ref: PullRequestRef): Promise<PullRequestComment[]>;
  findOpenPullRequests(query: {
    repository: RepositoryRef;
    sourceBranch: string;
  }): Promise<PullRequestRef[]>;
  getChecks(
    ref: PullRequestRef,
    options?: { requiredOnly?: boolean; signal?: AbortSignal },
  ): Promise<PullRequestCheck[]>;
  getReviews(ref: PullRequestRef): Promise<PullRequestReview[]>;
}

export type PullRequestFilePatch =
  | { status: "available"; text: string }
  | { status: "truncated"; text: string }
  | { status: "unavailable"; reason: "binary" | "too-large" | "not-provided" };

export type PullRequestFileDiff = {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "unknown";
  additions: number;
  deletions: number;
  patch: PullRequestFilePatch;
};

export type PullRequestDiff = {
  ref: PullRequestRef;
  baseCommit: string;
  headCommit: string;
  files: PullRequestFileDiff[];
  completeness: { status: "complete" } | { status: "incomplete"; reason: string };
};

export interface PullRequestDiffer {
  getDiff(ref: PullRequestRef): Promise<PullRequestDiff>;
}

export type PullRequestCommentThreadsQuery = {
  unresolved?: boolean;
  since?: string;
  limit: number;
};

export type PullRequestCommentThreads = {
  threads: PullRequestComment[][];
  hasMore: boolean;
  incomplete: boolean;
};

export interface PullRequestCommentThreadLister {
  listCommentThreads(
    ref: PullRequestRef,
    query: PullRequestCommentThreadsQuery,
  ): Promise<PullRequestCommentThreads>;
}

export type PullRequestThreadResolution = {
  threadId: string;
  isResolved: boolean;
  changed: boolean;
};

export interface PullRequestThreadResolver {
  setReviewThreadResolution(
    ref: PullRequestRef,
    threadId: string,
    isResolved: boolean,
  ): Promise<PullRequestThreadResolution>;
}

export type PullRequestReviewInput = {
  event: "approve" | "request-changes" | "comment";
  body?: string;
  expectedHead?: string;
};

export interface PullRequestReviewer {
  submitReview(ref: PullRequestRef, input: PullRequestReviewInput): Promise<PullRequestReview>;
}

export type PullRequestMergeInput = {
  method: "merge" | "squash" | "rebase";
  expectedHead?: string;
  deleteBranch?: boolean;
};

export type PullRequestMergeResult = {
  pr: PullRequest;
  deletedBranch: boolean;
};

export interface PullRequestMerger {
  mergePullRequest(
    ref: PullRequestRef,
    input: PullRequestMergeInput,
  ): Promise<PullRequestMergeResult>;
}

export type PullRequestListQuery = {
  repository: RepositoryRef;
  state: "open" | "closed" | "merged" | "all";
  author?: string;
  draft?: boolean;
  limit: number;
};

export type PullRequestListItem = PullRequest & {
  author: { id: string; name: string } | null;
};

export interface PullRequestLister {
  listPullRequests(query: PullRequestListQuery): Promise<PullRequestListItem[]>;
}

export type PullRequestCreateInput = {
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  reviewers?: string[];
  labels?: string[];
} & (
  | { repository: Extract<RepositoryRef, { provider: "github" }> }
  | { repository: Extract<RepositoryRef, { provider: "azure-devops" }> }
);

export type PullRequestPatch = {
  title?: string;
  body?: string;
  targetBranch?: string;
  isDraft?: boolean;
};

export interface PullRequestWriter {
  createPullRequest(input: PullRequestCreateInput): Promise<PullRequest>;
  editPullRequest(ref: PullRequestRef, patch: PullRequestPatch): Promise<PullRequest>;
}

export interface PullRequestReopener {
  reopenPullRequest(ref: PullRequestRef): Promise<PullRequest>;
}

export interface PullRequestCloser {
  closePullRequest(ref: PullRequestRef, options: { comment?: string }): Promise<PullRequest>;
}

export type PullRequestCommentInput = { body: string; replyTo?: string };

export interface PullRequestCommenter {
  addComment(ref: PullRequestRef, input: PullRequestCommentInput): Promise<PullRequestComment>;
}

export interface PullRequestReviewRequester {
  requestReview(
    ref: PullRequestRef,
    input: { reviewers: string[]; teams: string[] },
  ): Promise<{
    requested: string[];
    alreadyPending: string[];
  }>;
}
