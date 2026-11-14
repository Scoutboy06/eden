import { expect, mock, test } from "bun:test";
import {
  CommentThreadStatus,
  CommentType,
  PullRequestStatus,
} from "azure-devops-node-api/interfaces/GitInterfaces";
import type { PullRequestRef, RepositoryRef } from "../../../modules/pull-requests/provider";
import { azurePr, azureProvider } from "./support/azure";
import type { AzureGitClient } from "../provider";

const ref: PullRequestRef = {
  provider: "azure-devops",
  organizationUrl: "https://dev.azure.com/acme",
  id: 42,
};
const repository: RepositoryRef = {
  provider: "azure-devops",
  organizationUrl: "https://dev.azure.com/acme",
  project: "Product",
  repository: "app",
};

test("Azure comments preserve thread context and exclude deleted and system messages", async () => {
  const getThreads = mock<AzureGitClient["getThreads"]>(async () => [
    {
      id: 1,
      status: CommentThreadStatus.Fixed,
      threadContext: { filePath: "/app.ts", rightFileStart: { line: 4 } },
      comments: [
        {
          id: 1,
          content: "Fix this",
          commentType: CommentType.Text,
          author: { id: "alice", displayName: "Alice" },
          publishedDate: new Date("2026-01-01"),
        },
        { id: 2, content: "Deleted", commentType: CommentType.Text, isDeleted: true },
        { id: 3, content: "System", commentType: CommentType.System },
      ],
    },
    {
      id: 2,
      isDeleted: true,
      comments: [{ id: 1, content: "Hidden", commentType: CommentType.Text }],
    },
  ]);
  const provider = azureProvider({ getThreads });

  const comments = await provider.getComments(ref);

  expect(comments).toEqual([
    {
      id: "1:1",
      body: "Fix this",
      author: { id: "alice", name: "Alice" },
      createdAt: "2026-01-01T00:00:00.000Z",
      path: "/app.ts",
      line: 4,
      threadId: "1",
      isResolved: true,
    },
  ]);
  expect(getThreads).toHaveBeenCalledWith("repo-id", 42, "Product");
  expect(await azureProvider().getComments(ref)).toEqual([]);
});

test.each([
  [PullRequestStatus.Active, "open"],
  [PullRequestStatus.Abandoned, "closed"],
  [PullRequestStatus.Completed, "merged"],
] as const)("maps Azure lifecycle, draft and branch refs", async (status, state) => {
  const provider = azureProvider({ getPullRequestById: async () => azurePr({ status }) });

  const pullRequest = await provider.getPullRequest(ref);

  expect(pullRequest).toEqual({
    ref,
    title: "Improve login",
    body: "Details",
    state,
    isDraft: true,
    url: "https://dev.azure.com/acme/Product/_git/repo-id/pullrequest/42",
    sourceBranch: "topic",
    targetBranch: "main",
  });
});

test("Azure branch discovery uses full refs and paginates", async () => {
  const getPullRequests = mock<AzureGitClient["getPullRequests"]>(
    async (_repository, _criteria, _project, _length, skip) =>
      skip === 0
        ? Array.from({ length: 100 }, (_, index) => azurePr({ pullRequestId: index + 1 }))
        : [azurePr({ pullRequestId: 101 })],
  );
  const provider = azureProvider({ getPullRequests });

  const pullRequests = await provider.findOpenPullRequests({
    repository,
    sourceBranch: "topic",
  });

  expect(pullRequests).toHaveLength(101);
  expect(getPullRequests.mock.calls[0]).toEqual([
    "app",
    { status: PullRequestStatus.Active, sourceRefName: "refs/heads/topic" },
    "Product",
    undefined,
    0,
    100,
  ]);
  expect(getPullRequests.mock.calls[1]?.[4]).toBe(100);
});
