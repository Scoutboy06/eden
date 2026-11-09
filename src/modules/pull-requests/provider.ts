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
