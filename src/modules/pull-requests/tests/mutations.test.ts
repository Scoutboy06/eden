import { expect, test } from "bun:test";
import { createExecution } from "../../execution/execution";
import { PullRequestService } from "../service";
import { ScmError } from "../errors";
import type { PullRequestProvider, PullRequestWriter, RepositoryRef } from "../provider";
import { githubProvider } from "../../../external/github/tests/support/github";

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
