import { expect, mock, test } from "bun:test";
import { PullRequestStatus } from "azure-devops-node-api/interfaces/GitInterfaces";
import type { PullRequestListQuery } from "../../../modules/pull-requests/provider";
import { azurePr, azureProvider } from "./support/azure";
import type { AzureGitClient } from "../provider";

const query: PullRequestListQuery = {
  repository: {
    provider: "azure-devops",
    organizationUrl: "https://dev.azure.com/acme",
    project: "Product",
    repository: "app",
  },
  state: "open",
  limit: 30,
};

test("filters Azure listing by closed state, creator and draft while preserving author identity", async () => {
  const creatorId = "123e4567-e89b-42d3-a456-426614174000";
  const getPullRequests = mock<AzureGitClient["getPullRequests"]>(async () => [
    azurePr({
      pullRequestId: 1,
      status: PullRequestStatus.Active,
      isDraft: false,
      createdBy: { id: creatorId, displayName: "Alice" },
    }),
    azurePr({
      pullRequestId: 2,
      status: PullRequestStatus.Active,
      isDraft: true,
      createdBy: { id: creatorId, displayName: "Alice" },
    }),
    azurePr({
      pullRequestId: 3,
      status: PullRequestStatus.Abandoned,
      isDraft: true,
      createdBy: { id: creatorId, displayName: "Alice" },
    }),
  ]);
  const provider = azureProvider({ getPullRequests });

  const result = await provider.listPullRequests({
    ...query,
    state: "closed",
    author: creatorId,
    draft: true,
  });

  expect(result).toHaveLength(1);
  expect(result[0]?.author).toEqual({ id: creatorId, name: "Alice" });
  expect(getPullRequests.mock.calls[0]?.[1]).toMatchObject({
    status: PullRequestStatus.Abandoned,
    creatorId,
  });
});

test("continues paging past excluded drafts until it reaches the matching limit", async () => {
  const getPullRequests = mock<AzureGitClient["getPullRequests"]>(
    async (_repo, _criteria, _project, _length, skip) =>
      skip === 0
        ? Array.from({ length: 100 }, (_, index) =>
            azurePr({ pullRequestId: index + 1, isDraft: true }),
          )
        : [
            azurePr({ pullRequestId: 101, isDraft: false }),
            azurePr({ pullRequestId: 102, isDraft: false }),
          ],
  );
  const provider = azureProvider({ getPullRequests });

  const result = await provider.listPullRequests({ ...query, draft: false, limit: 1 });

  expect(result.map((item) => (item.ref.provider === "azure-devops" ? item.ref.id : 0))).toEqual([
    101,
  ]);
  expect(getPullRequests).toHaveBeenCalledTimes(2);
});

test("empty listing returns no items and malformed creator or repository identities fail", async () => {
  expect(await azureProvider().listPullRequests(query)).toEqual([]);
  await expect(
    azureProvider({
      getPullRequests: async () => [azurePr({ createdBy: { id: "alice", displayName: "Alice" } })],
    }).listPullRequests(query),
  ).rejects.toMatchObject({ code: "SCM_INVALID_RESPONSE" });
  await expect(
    azureProvider({
      getPullRequests: async () => [
        azurePr({
          repository: { id: "other", name: "app", project: { id: "project-id", name: "Product" } },
        }),
      ],
    }).listPullRequests(query),
  ).rejects.toMatchObject({ code: "SCM_INVALID_RESPONSE" });
  await expect(
    azureProvider().listPullRequests({ ...query, author: "alice" }),
  ).rejects.toMatchObject({ code: "SCM_INVALID_OPTIONS" });
});

test("provider failures remain structured", async () => {
  await expect(
    azureProvider({
      getPullRequests: async () => {
        throw new Error("credential detail");
      },
    }).listPullRequests(query),
  ).rejects.toMatchObject({ code: "SCM_REQUEST_FAILED" });
});
