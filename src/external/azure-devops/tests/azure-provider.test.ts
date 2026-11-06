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

test("Azure create sends project, repository, normalized branches and draft then returns its identity", async () => {
  const createPullRequest = mock<AzureGitClient["createPullRequest"]>(async () => azurePr());
  const provider = azureProvider({ createPullRequest });

  const result = await provider.createPullRequest({
    repository,
    title: "Improve login",
    body: "",
    sourceBranch: "refs/heads/topic",
    targetBranch: "main",
    draft: false,
  });

  expect(createPullRequest).toHaveBeenCalledWith(
    {
      title: "Improve login",
      description: "",
      sourceRefName: "refs/heads/topic",
      targetRefName: "refs/heads/main",
      isDraft: false,
    },
    "repo-id",
    "project-id",
  );
  expect(result).toMatchObject({
    ref,
    body: "Details",
    isDraft: true,
    sourceBranch: "topic",
    targetBranch: "main",
  });
});

test("Azure create resolves names and GUIDs, then uses canonical IDs", async () => {
  const guidRepository: RepositoryRef = {
    ...repository,
    repository: "A1B2C3D4-E5F6-4711-ABCD-0123456789AB",
    project: "B1B2C3D4-E5F6-4711-ABCD-0123456789AB",
  };
  const getRepository = mock<AzureGitClient["getRepository"]>(async () => ({
    id: "CANONICAL-REPO-ID",
    name: "App",
    project: { id: "CANONICAL-PROJECT-ID", name: "Product" },
  }));
  const createPullRequest = mock<AzureGitClient["createPullRequest"]>(async () =>
    azurePr({
      repository: {
        id: "canonical-repo-id",
        name: "App",
        project: { id: "canonical-project-id", name: "Product" },
      },
    }),
  );
  const provider = azureProvider({ getRepository, createPullRequest });

  await expect(
    provider.createPullRequest({
      repository: guidRepository,
      title: "Title",
      body: "",
      sourceBranch: "topic",
      targetBranch: "main",
      draft: false,
    }),
  ).resolves.toMatchObject({ state: "open", ref: { id: 42 } });

  expect(getRepository).toHaveBeenCalledWith(guidRepository.repository, guidRepository.project);
  expect(createPullRequest).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Title" }),
    "CANONICAL-REPO-ID",
    "CANONICAL-PROJECT-ID",
  );
});

test("Azure create treats UUID-shaped names as resolver inputs and rejects mismatched response IDs", async () => {
  const uuidNameRepository: RepositoryRef = {
    ...repository,
    repository: "A1B2C3D4-E5F6-4711-ABCD-0123456789AB",
    project: "B1B2C3D4-E5F6-4711-ABCD-0123456789AB",
  };
  const getRepository = mock<AzureGitClient["getRepository"]>(async () => ({
    id: "canonical-repo-id",
    name: uuidNameRepository.repository,
    project: { id: "canonical-project-id", name: uuidNameRepository.project },
  }));
  const input = {
    repository: uuidNameRepository,
    title: "Title",
    body: "",
    sourceBranch: "topic",
    targetBranch: "main",
    draft: false,
  };
  const resolvedCreate = mock<AzureGitClient["createPullRequest"]>(async () =>
    azurePr({
      repository: {
        id: "CANONICAL-REPO-ID",
        name: uuidNameRepository.repository,
        project: { id: "CANONICAL-PROJECT-ID", name: uuidNameRepository.project },
      },
    }),
  );
  const resolvedProvider = azureProvider({ getRepository, createPullRequest: resolvedCreate });

  await expect(resolvedProvider.createPullRequest(input)).resolves.toMatchObject({ state: "open" });
  expect(resolvedCreate).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Title" }),
    "canonical-repo-id",
    "canonical-project-id",
  );

  const createPullRequest = mock<AzureGitClient["createPullRequest"]>(async () =>
    azurePr({
      repository: {
        id: "wrong-repo-id",
        name: uuidNameRepository.repository,
        project: { id: "wrong-project-id", name: uuidNameRepository.project },
      },
    }),
  );
  const mismatchProvider = azureProvider({ getRepository, createPullRequest });

  await expect(mismatchProvider.createPullRequest(input)).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
  });

  expect(getRepository).toHaveBeenCalledWith(
    uuidNameRepository.repository,
    uuidNameRepository.project,
  );
  expect(createPullRequest).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Title" }),
    "canonical-repo-id",
    "canonical-project-id",
  );
});

test("Azure edit discovers repo and project from the exact PR before applying an exact patch", async () => {
  const getPullRequestById = mock<AzureGitClient["getPullRequestById"]>(async () => azurePr());
  const updatePullRequest = mock<AzureGitClient["updatePullRequest"]>(async () =>
    azurePr({ isDraft: false }),
  );
  const provider = azureProvider({ getPullRequestById, updatePullRequest });

  await provider.editPullRequest(ref, {
    body: "",
    isDraft: false,
    targetBranch: "refs/heads/release",
  });

  expect(getPullRequestById).toHaveBeenCalledWith(42);
  expect(updatePullRequest).toHaveBeenCalledWith(
    {
      description: "",
      isDraft: false,
      targetRefName: "refs/heads/release",
    },
    "repo-id",
    42,
    "Product",
  );
});

test("Azure writes reject mismatched organizations and identities without retargeting", async () => {
  const createPullRequest = mock<AzureGitClient["createPullRequest"]>(async () => azurePr());
  const getPullRequestById = mock<AzureGitClient["getPullRequestById"]>(async () =>
    azurePr({ repository: { id: "other", project: { name: "Product" } } }),
  );
  const provider = azureProvider({ createPullRequest, getPullRequestById });

  await expect(
    provider.createPullRequest({
      repository: { ...repository, organizationUrl: "https://dev.azure.com/other" },
      title: "Title",
      body: "",
      sourceBranch: "topic",
      targetBranch: "main",
      draft: false,
    }),
  ).rejects.toMatchObject({ code: "SCM_PROVIDER_MISMATCH" });
  const wrongTarget = azureProvider({
    createPullRequest: async () =>
      azurePr({
        repository: {
          id: "other-id",
          name: "other",
          project: { id: "other-project", name: "Other" },
        },
      }),
  });
  await expect(
    wrongTarget.createPullRequest({
      repository,
      title: "Title",
      body: "",
      sourceBranch: "topic",
      targetBranch: "main",
      draft: false,
    }),
  ).rejects.toMatchObject({ code: "SCM_PARTIAL_FAILURE" });
  await expect(provider.editPullRequest(ref, { title: "Changed" })).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
  });
  expect(createPullRequest).not.toHaveBeenCalled();
});

test("Azure edit accepts casing changes in the discovered repository and project identity", async () => {
  const getPullRequestById = mock<AzureGitClient["getPullRequestById"]>(async () =>
    azurePr({
      repository: {
        id: "REPO-ID",
        project: { id: "project-id", name: "product" },
      },
    }),
  );
  const updatePullRequest = mock<AzureGitClient["updatePullRequest"]>(async () =>
    azurePr({
      repository: {
        id: "repo-id",
        project: { id: "project-id", name: "PRODUCT" },
      },
    }),
  );
  const provider = azureProvider({ getPullRequestById, updatePullRequest });

  await expect(provider.editPullRequest(ref, { title: "Updated" })).resolves.toMatchObject({
    title: "Improve login",
  });
  expect(updatePullRequest).toHaveBeenCalledWith({ title: "Updated" }, "REPO-ID", 42, "product");
});

test("Azure required checks include only enabled blocking build and status evaluations", async () => {
  const getPullRequestStatuses = mock<AzureGitClient["getPullRequestStatuses"]>(async () => []);
  const provider = azureProvider(
    { getPullRequestStatuses },
    {
      getPolicyEvaluations: async () => [
        {
          evaluationId: "required-build",
          status: PolicyEvaluationStatus.Running,
          configuration: {
            isBlocking: true,
            isEnabled: true,
            type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
            settings: {},
          },
        },
        {
          evaluationId: "required-status",
          status: PolicyEvaluationStatus.Approved,
          configuration: {
            isBlocking: true,
            isEnabled: true,
            type: { id: "c2a1889d-b943-4856-b76f-9e46bb6b0df2" },
            settings: { statusName: "Security" },
          },
        },
        {
          evaluationId: "optional-build",
          configuration: {
            isBlocking: false,
            isEnabled: true,
            type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
            settings: {},
          },
        },
        {
          evaluationId: "disabled-build",
          configuration: {
            isBlocking: true,
            isEnabled: false,
            type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
            settings: {},
          },
        },
        {
          evaluationId: "reviewer-policy",
          configuration: {
            isBlocking: true,
            isEnabled: true,
            type: { id: "reviewer-policy" },
            settings: {},
          },
        },
      ],
    },
  );

  expect(await provider.getChecks(ref, { requiredOnly: true })).toEqual([
    { id: "build:required-build", name: "Build validation", state: "running" },
    { id: "policy:required-status", name: "Security", state: "passed" },
  ]);
  expect(getPullRequestStatuses).not.toHaveBeenCalled();
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
