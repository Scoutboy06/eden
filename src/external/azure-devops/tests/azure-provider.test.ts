import { expect, mock, test } from "bun:test";
import {
  CommentThreadStatus,
  CommentType,
  GitStatusState,
  PullRequestStatus,
} from "azure-devops-node-api/interfaces/GitInterfaces";
import { PolicyEvaluationStatus } from "azure-devops-node-api/interfaces/PolicyInterfaces";
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

test("Azure raw fields are opt-in", async () => {
  const provider = azureProvider();

  expect((await provider.getPullRequest(ref)).raw).toBeUndefined();
  expect((await provider.getPullRequest(ref, { raw: true })).raw).toEqual(azurePr());
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

  expect(await provider.getComments(ref)).toEqual([
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

  expect(await provider.getPullRequest(ref)).toEqual({
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

  expect(await provider.findOpenPullRequests({ repository, sourceBranch: "topic" })).toHaveLength(
    101,
  );
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

test("Azure checks include status checks and only automated build policies", async () => {
  const provider = azureProvider(
    {
      getPullRequestStatuses: async () => [
        { id: 1, context: { genre: "ci", name: "external" }, state: GitStatusState.Failed },
        {
          id: 2,
          context: { genre: "ci", name: "external" },
          state: GitStatusState.Succeeded,
          targetUrl: "https://example.com/build",
        },
      ],
    },
    {
      getPolicyEvaluations: async () => [
        {
          evaluationId: "build",
          configuration: {
            isBlocking: true,
            isEnabled: true,
            type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
            settings: { displayName: "Build" },
          },
          status: PolicyEvaluationStatus.Running,
        },
        {
          evaluationId: "review-policy",
          configuration: {
            isBlocking: true,
            isEnabled: true,
            settings: {},
            type: { id: "reviewer-count-policy" },
          },
          status: PolicyEvaluationStatus.Rejected,
        },
      ],
    },
  );

  expect(await provider.getChecks(ref)).toEqual([
    { id: "status:2", name: "external", state: "passed", url: "https://example.com/build" },
    { id: "build:build", name: "Build", state: "running" },
  ]);
});

test("Azure reviews preserve votes without forcing them into GitHub states", async () => {
  const provider = azureProvider({
    getPullRequestReviewers: async () =>
      [10, 5, 0, -5, -10, 17].map((vote) => ({
        id: String(vote),
        displayName: `Reviewer ${vote}`,
        vote,
      })),
  });

  expect((await provider.getReviews(ref)).map((review) => review.state)).toEqual([
    "approved",
    "approved-with-suggestions",
    "pending",
    "changes-requested",
    "rejected",
    "unknown",
  ]);
});

test("Azure references cannot cross organizations", async () => {
  const provider = azureProvider({
    getPullRequestById: async () => {
      throw new Error("must not request");
    },
  });

  await expect(
    provider.getPullRequest({ ...ref, organizationUrl: "https://dev.azure.com/other" }),
  ).rejects.toMatchObject({ code: "SCM_PROVIDER_MISMATCH" });
});

test("Azure SDK status errors are translated without leaking secrets", async () => {
  const provider = azureProvider({
    getPullRequestById: async () => {
      throw Object.assign(new Error("secret-pat"), { statusCode: 401 });
    },
  });

  await expect(provider.getPullRequest(ref)).rejects.toMatchObject({
    code: "SCM_AUTHENTICATION_FAILED",
  });
  await expect(provider.getPullRequest(ref)).rejects.not.toThrow("secret-pat");
});

test("incomplete Azure responses are invalid, not empty PRs", async () => {
  const provider = azureProvider({ getPullRequestById: async () => ({}) });

  await expect(provider.getPullRequest(ref)).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
});
