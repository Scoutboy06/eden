import { Octokit } from "@octokit/rest";
import { GitApi } from "azure-devops-node-api/GitApi";
import { PolicyApi } from "azure-devops-node-api/PolicyApi";
import { getBearerHandler, getPersonalAccessTokenHandler } from "azure-devops-node-api";
import { AzureDevOpsApiProvider } from "./azure-provider";
import { GitHubApiProvider } from "./github-provider";
import { resolveCredential } from "./credentials";
import type { PullRequestProvider, RepositoryRef } from "./provider";
import { parseRepositoryUrl, repositoryUrl } from "./targets";

export async function createPullRequestProvider(
  repository: RepositoryRef,
): Promise<PullRequestProvider> {
  parseRepositoryUrl(repositoryUrl(repository));
  const credential = await resolveCredential(repository);

  if (repository.provider === "github") {
    return new GitHubApiProvider(
      new Octokit({
        auth: credential?.token,
        request: { timeout: 30_000, redirect: "error" },
        log: { debug() {}, info() {}, warn() {}, error() {} },
      }),
    );
  }

  const handlers = credential
    ? [
        credential.kind === "pat"
          ? getPersonalAccessTokenHandler(credential.token)
          : getBearerHandler(credential.token),
      ]
    : [];
  const options = { socketTimeout: 30_000, allowRedirects: false, maxRetries: 0 };

  return new AzureDevOpsApiProvider(
    repository.organizationUrl,
    new GitApi(repository.organizationUrl, handlers, options),
    new PolicyApi(repository.organizationUrl, handlers, options),
  );
}
