import { createAzureDevOpsApiProvider } from "../../external/azure-devops/provider";
import { createGitHubApiProvider } from "../../external/github/provider";
import { resolveCredential } from "./credentials";
import type { PullRequestProvider, RepositoryRef } from "./provider";
import { parseRepositoryUrl, repositoryUrl } from "./targets";

export async function createPullRequestProvider(
  repository: RepositoryRef,
): Promise<PullRequestProvider> {
  parseRepositoryUrl(repositoryUrl(repository));
  const credential = await resolveCredential(repository);

  return repository.provider === "github"
    ? createGitHubApiProvider(credential)
    : createAzureDevOpsApiProvider(repository.organizationUrl, credential);
}
