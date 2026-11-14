import { expect, mock, test } from "bun:test";
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

  const normalizedPullRequest = await provider.getPullRequest(ref);
  const rawPullRequest = await provider.getPullRequest(ref, { raw: true });

  expect(normalizedPullRequest.raw).toBeUndefined();
  expect(rawPullRequest.raw).toEqual(azurePr());
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
