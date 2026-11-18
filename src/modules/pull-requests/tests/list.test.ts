import { expect, mock, test } from "bun:test";
import { PullRequestService } from "../service";
import { createExecution } from "../../execution/execution";
import { githubProvider } from "../../../external/github/tests/support/github";
import { azureProvider } from "../../../external/azure-devops/tests/support/azure";
import type { PullRequestProvider } from "../provider";

function fixture() {
  const execution = createExecution({ dryRun: true });
  const { provider, calls } = githubProvider(() => Response.json([]));
  let selections = 0;
  const service = new PullRequestService(
    {
      remotes: async () => [{ name: "origin", url: "git@github.com:acme/app.git" }],
      branch: async () => {
        throw new Error("Listing must not inspect the branch");
      },
    },
    async () => {
      selections++;
      return provider;
    },
    execution,
  );

  return { service, execution, calls, selections: () => selections };
}

test("listing infers repository without a branch and dry-run still performs reads only", async () => {
  const { service, execution, calls } = fixture();

  const result = await service.list({});

  expect(result).toEqual({
    repository: { provider: "github", owner: "acme", repository: "app" },
    prs: [],
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.searchParams.get("state")).toBe("open");
  expect(calls[0]?.searchParams.get("per_page")).toBe("30");
  expect(execution.operations).toEqual([]);
});

test.each([
  { limit: 0 },
  { limit: -1 },
  { limit: 1.5 },
  { limit: Infinity },
  { limit: Number.MAX_SAFE_INTEGER + 1 },
  { state: "invalid" },
  { author: "" },
  { author: "a".repeat(40) },
  { author: "@me" },
  { repo: "" },
  { remote: "" },
  { repo: "https://github.com/acme/app", remote: "origin" },
])("rejects invalid list options before provider selection %#", async (input) => {
  const { service, selections } = fixture();

  await expect(service.list(input as Parameters<PullRequestService["list"]>[0])).rejects.toThrow();
  expect(selections()).toBe(0);
});

test("explicit repo selection works without accessing local Git", async () => {
  const { provider } = githubProvider(() => Response.json([]));
  const service = new PullRequestService(
    {
      remotes: async () => {
        throw new Error("No checkout");
      },
      branch: async () => {
        throw new Error("No checkout");
      },
    },
    async () => provider,
  );

  expect((await service.list({ repo: "https://github.com/acme/app" })).prs).toEqual([]);
});

test("Azure listing resolves explicit repository and forwards Azure filters", async () => {
  const provider = azureProvider();
  const listPullRequests = mock(provider.listPullRequests.bind(provider));
  provider.listPullRequests = listPullRequests;
  const service = new PullRequestService(undefined, async () => provider);

  const result = await service.list({
    repo: "https://dev.azure.com/acme/project/_git/app",
    state: "merged",
    author: "fce95fea-d8c2-45ce-902b-d6901dd0abc6",
    draft: false,
    limit: 7,
  });

  expect(result.repository).toEqual({
    provider: "azure-devops",
    organizationUrl: "https://dev.azure.com/acme",
    project: "project",
    repository: "app",
  });
  expect(listPullRequests).toHaveBeenCalledWith({
    repository: result.repository,
    state: "merged",
    author: "fce95fea-d8c2-45ce-902b-d6901dd0abc6",
    draft: false,
    limit: 7,
  });
});

test("providers without listing capability are rejected explicitly", async () => {
  const service = new PullRequestService(undefined, async () => ({}) as PullRequestProvider);

  await expect(service.list({ repo: "https://github.com/acme/app" })).rejects.toMatchObject({
    code: "SCM_UNSUPPORTED_OPERATION",
  });
});
