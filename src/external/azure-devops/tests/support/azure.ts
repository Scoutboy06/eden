import {
  AzureDevOpsApiProvider,
  type AzureGitClient,
  type AzurePolicyClient,
} from "../../provider";
import {
  PullRequestStatus,
  type GitPullRequest,
} from "azure-devops-node-api/interfaces/GitInterfaces";

export function azurePr(overrides: Partial<GitPullRequest> = {}): GitPullRequest {
  return {
    pullRequestId: 42,
    title: "Improve login",
    description: "Details",
    status: PullRequestStatus.Active,
    isDraft: true,
    sourceRefName: "refs/heads/topic",
    targetRefName: "refs/heads/main",
    repository: { id: "repo-id", name: "app", project: { id: "project-id", name: "Product" } },
    ...overrides,
  };
}

export function azureProvider(
  git: Partial<AzureGitClient> = {},
  policies: Partial<AzurePolicyClient> = {},
) {
  const client: AzureGitClient = {
    getPullRequestById: async () => azurePr(),
    getPullRequests: async () => [],
    getPullRequestStatuses: async () => [],
    getPullRequestReviewers: async () => [],
    ...git,
  };
  const policyClient: AzurePolicyClient = { getPolicyEvaluations: async () => [], ...policies };

  return new AzureDevOpsApiProvider("https://dev.azure.com/acme", client, policyClient);
}
