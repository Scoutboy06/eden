import { expect, mock, test } from "bun:test";
import { createExecution } from "../../execution/execution";
import { PullRequestService } from "../service";
import { ScmError } from "../errors";
import type { PullRequestProvider, PullRequestWriter, RepositoryRef } from "../provider";
import { githubProvider } from "../../../external/github/tests/support/github";
import { azureProvider } from "../../../external/azure-devops/tests/support/azure";
import type { AzureGitClient } from "../../../external/azure-devops/provider";

const repository: RepositoryRef = { provider: "github", owner: "acme", repository: "app" };
const pr = {
  ref: { ...repository, number: 12 },
  url: "https://github.com/acme/app/pull/12",
  title: "Title",
  body: "",
  state: "open" as const,
  isDraft: false,
  sourceBranch: "topic",
  targetBranch: "main",
};

function fixture(dryRun = false, capabilities = true) {
  const execution = createExecution({ dryRun });
  const calls: unknown[] = [];
  let providerSelections = 0;
  const provider = {
    async getPullRequest() {
      return pr;
    },
    async getComments() {
      return [];
    },
    async findOpenPullRequests() {
      return [];
    },
    async getChecks() {
      return [];
    },
    async getReviews() {
      return [];
    },
    ...(capabilities
      ? {
          async createPullRequest(input: unknown) {
            calls.push(input);
            return pr;
          },
          async editPullRequest(ref: unknown, patch: unknown) {
            calls.push({ ref, patch });
            return pr;
          },
        }
      : {}),
  } as PullRequestProvider & Partial<PullRequestWriter>;
  const service = new PullRequestService(
    undefined,
    async () => {
      providerSelections++;
      return provider;
    },
    execution,
  );
  return {
    service,
    execution,
    calls,
    get providerSelections() {
      return providerSelections;
    },
  };
}

test("dry-run records create and edit without invoking provider writes", async () => {
  const { service, execution, calls } = fixture(true);
  const created = await service.create({
    repository,
    title: "Title",
    body: "",
    sourceBranch: "topic",
    targetBranch: "main",
    draft: false,
  });
  const edited = await service.edit(pr.ref, { body: "", isDraft: false });

  expect(created).toBeUndefined();
  expect(edited).toBeUndefined();
  expect(calls).toEqual([]);
  expect(execution.operations).toHaveLength(2);
});

test("dry-run with the real GitHub adapter sends no HTTP requests", async () => {
  const requests: URL[] = [];
  const { provider } = githubProvider((url) => {
    requests.push(url);
    return Response.json({});
  });
  const execution = createExecution({ dryRun: true });
  const service = new PullRequestService(undefined, async () => provider, execution);

  await service.create({
    repository,
    title: "Title",
    body: "",
    sourceBranch: "topic",
    targetBranch: "main",
    draft: false,
  });
  await service.edit(pr.ref, { isDraft: true });

  expect(requests).toEqual([]);
  expect(execution.operations).toHaveLength(2);
});

test("validates inputs before provider selection and rejects unsupported writes", async () => {
  const { service } = fixture();
  await expect(
    service.create({
      repository,
      title: " ",
      body: "",
      sourceBranch: "topic",
      targetBranch: "main",
      draft: false,
    }),
  ).rejects.toBeInstanceOf(ScmError);
  await expect(service.edit(pr.ref, {})).rejects.toBeInstanceOf(ScmError);
  const unsupported = fixture(false, false);
  await expect(
    unsupported.service.create({
      repository,
      title: "Title",
      body: "",
      sourceBranch: "topic",
      targetBranch: "main",
      draft: false,
    }),
  ).rejects.toMatchObject({ code: "SCM_UNSUPPORTED_OPERATION" });
});

test("rejects unknown edit fields alongside valid fields before provider selection", async () => {
  const { service, execution, calls, providerSelections } = fixture();

  await expect(
    service.edit(pr.ref, { title: "Updated", draft: true } as never),
  ).rejects.toMatchObject({ code: "SCM_INVALID_REFERENCE" });

  expect(providerSelections).toBe(0);
  expect(execution.operations).toEqual([]);
  expect(calls).toEqual([]);
});

test("create preserves false and empty body while edit preserves explicit false", async () => {
  const { service, calls } = fixture();
  await service.create({
    repository,
    title: "Title",
    body: "",
    sourceBranch: "topic",
    targetBranch: "main",
    draft: false,
  });
  await service.edit(pr.ref, { body: "", isDraft: false });

  expect(calls).toEqual([
    {
      repository,
      title: "Title",
      body: "",
      sourceBranch: "topic",
      targetBranch: "main",
      draft: false,
    },
    { ref: pr.ref, patch: { body: "", isDraft: false } },
  ]);
});

test("edit by reference resolves an explicit number without fetching the PR", async () => {
  const { service, calls } = fixture();

  await service.editByReference({ ref: "12", repo: "https://github.com/acme/app" }, { body: "" });

  expect(calls).toEqual([{ ref: pr.ref, patch: { body: "" } }]);
});

test("edit by reference rejects missing, conflicting and invalid targets without writes", async () => {
  const { service, calls, execution } = fixture();

  for (const input of [
    { ref: "" },
    { ref: "topic", repo: "https://github.com/acme/app" },
    { ref: "https://github.com/acme/app/pull/12", repo: "https://github.com/acme/other" },
  ]) {
    await expect(service.editByReference(input, { title: "Updated" })).rejects.toBeInstanceOf(
      ScmError,
    );
  }

  expect(calls).toEqual([]);
  expect(execution.operations).toEqual([]);
});

test("Azure dry-run records writes without resolving or mutating the PR through the SDK", async () => {
  const getPullRequestById = mock<AzureGitClient["getPullRequestById"]>(async () => {
    throw new Error("must not call SDK");
  });
  const getRepository = mock<AzureGitClient["getRepository"]>(async () => {
    throw new Error("must not call SDK");
  });
  const createPullRequest = mock<AzureGitClient["createPullRequest"]>(async () => {
    throw new Error("must not call SDK");
  });
  const provider = azureProvider({ getPullRequestById, getRepository, createPullRequest });
  const execution = createExecution({ dryRun: true });
  const service = new PullRequestService(undefined, async () => provider, execution);
  const azureRepository: RepositoryRef = {
    provider: "azure-devops",
    organizationUrl: "https://dev.azure.com/acme",
    project: "Product",
    repository: "app",
  };
  const azureRef = {
    provider: "azure-devops" as const,
    organizationUrl: azureRepository.organizationUrl,
    id: 42,
  };

  expect(
    await service.create({
      repository: azureRepository,
      title: "Title",
      body: "",
      sourceBranch: "topic",
      targetBranch: "main",
      draft: false,
    }),
  ).toBeUndefined();
  expect(await service.edit(azureRef, { body: "", isDraft: false })).toBeUndefined();
  expect(getPullRequestById).not.toHaveBeenCalled();
  expect(getRepository).not.toHaveBeenCalled();
  expect(createPullRequest).not.toHaveBeenCalled();
  expect(execution.operations.map(({ type }) => type)).toEqual([
    "azure-devops-pr-create",
    "azure-devops-pr-edit",
  ]);
});
