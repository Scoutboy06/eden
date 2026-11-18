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

test("Azure top-level comments create a thread and return the exact comment identity", async () => {
  const createThread = mock<AzureGitClient["createThread"]>(async () => ({
    id: 17,
    comments: [{ id: 23, content: "Hello", commentType: CommentType.Text }],
  }));
  const provider = azureProvider({ createThread });

  expect(await provider.addComment(ref, { body: "Hello" })).toMatchObject({
    id: "17:23",
    body: "Hello",
    threadId: "17",
  });
  expect(createThread.mock.calls[0]?.[0]).toEqual({
    comments: [{ content: "Hello", commentType: CommentType.Text }],
  });
});

test("Azure replies use the selected thread and parent comment IDs", async () => {
  const getPullRequestThread = mock<AzureGitClient["getPullRequestThread"]>(async () => ({
    id: 17,
    comments: [{ id: 23, content: "Parent" }],
  }));
  const createComment = mock<AzureGitClient["createComment"]>(async () => ({
    id: 24,
    content: "Reply",
    commentType: CommentType.Text,
  }));
  const provider = azureProvider({ getPullRequestThread, createComment });

  expect(await provider.addComment(ref, { body: "Reply", replyTo: "azure:17:23" })).toMatchObject({
    id: "17:24",
    body: "Reply",
    threadId: "17",
    replyTo: "17:23",
  });
  expect(getPullRequestThread.mock.calls[0]).toEqual(["repo-id", 42, 17, "Product"]);
  expect(createComment.mock.calls[0]).toEqual([
    { content: "Reply", parentCommentId: 23, commentType: CommentType.Text },
    "repo-id",
    42,
    17,
    "Product",
  ]);
});

test.each([
  { id: 17, isDeleted: true, comments: [{ id: 23 }] },
  { id: 17, comments: [{ id: 23, isDeleted: true }] },
  { id: 17, comments: [] },
  { id: 18, comments: [{ id: 23 }] },
])("Azure missing or deleted reply targets fail before writes %#", async (thread) => {
  const createComment = mock<AzureGitClient["createComment"]>(async () => ({}));
  const provider = azureProvider({
    getPullRequestThread: async () => ({
      ...thread,
      comments: thread.comments.map((comment) => ({ ...comment })),
    }),
    createComment,
  });

  await expect(
    provider.addComment(ref, { body: "No post", replyTo: "azure:17:23" }),
  ).rejects.toMatchObject({ code: "SCM_NOT_FOUND" });
  expect(createComment).not.toHaveBeenCalled();
});

test("Azure reply confirmation rejects a different parent", async () => {
  const provider = azureProvider({
    getPullRequestThread: async () => ({ id: 17, comments: [{ id: 23 }] }),
    createComment: async () => ({
      id: 24,
      content: "Reply",
      commentType: CommentType.Text,
      parentCommentId: 99,
    }),
  });

  await expect(
    provider.addComment(ref, { body: "Reply", replyTo: "azure:17:23" }),
  ).rejects.toMatchObject({ code: "SCM_PARTIAL_FAILURE" });
});

test("Azure missing postwrite thread identity reports possible application", async () => {
  const provider = azureProvider({
    createThread: async () => ({
      comments: [{ id: 1, content: "Hello", commentType: CommentType.Text }],
    }),
  });

  await expect(provider.addComment(ref, { body: "Hello" })).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
  });
});

test("Azure denied comments retain structured errors", async () => {
  const provider = azureProvider({
    createThread: async () => {
      throw Object.assign(new Error("private diagnostic"), { statusCode: 403 });
    },
  });

  await expect(provider.addComment(ref, { body: "Hello" })).rejects.toMatchObject({
    code: "SCM_ACCESS_DENIED",
    message: "The provider denied access to this operation.",
  });
});

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

test("Azure list resolves canonical IDs, paginates, and preserves Azure author identity", async () => {
  const getRepository = mock<AzureGitClient["getRepository"]>(async () => ({
    id: "repo-id",
    name: "app",
    project: { id: "project-id", name: "Product" },
  }));
  const getPullRequests = mock<AzureGitClient["getPullRequests"]>(
    async (_repository, _criteria, _project, _length, skip) =>
      skip === 0
        ? Array.from({ length: 100 }, (_, index) =>
            azurePr({
              pullRequestId: index + 1,
              status: PullRequestStatus.Completed,
              isDraft: false,
              createdBy: {
                id: "fce95fea-d8c2-45ce-902b-d6901dd0abc6",
                displayName: "Eden Test",
              },
            }),
          )
        : [
            azurePr({
              pullRequestId: 101,
              status: PullRequestStatus.Completed,
              isDraft: false,
              createdBy: {
                id: "fce95fea-d8c2-45ce-902b-d6901dd0abc6",
                displayName: "Eden Test",
              },
            }),
          ],
  );
  const provider = azureProvider({ getRepository, getPullRequests });

  const pullRequests = await provider.listPullRequests({
    repository,
    state: "merged",
    author: "fce95fea-d8c2-45ce-902b-d6901dd0abc6",
    draft: false,
    limit: 101,
  });

  expect(getRepository).toHaveBeenCalledWith("app", "Product");
  expect(getPullRequests.mock.calls[0]).toEqual([
    "repo-id",
    { status: PullRequestStatus.Completed, creatorId: "fce95fea-d8c2-45ce-902b-d6901dd0abc6" },
    "project-id",
    undefined,
    0,
    100,
  ]);
  expect(getPullRequests.mock.calls[1]?.[4]).toBe(100);
  expect(pullRequests).toHaveLength(101);
  expect(pullRequests[0]).toMatchObject({
    state: "merged",
    isDraft: false,
    author: { id: "fce95fea-d8c2-45ce-902b-d6901dd0abc6", name: "Eden Test" },
  });
});
