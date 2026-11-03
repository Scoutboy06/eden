import { expect, mock, test } from "bun:test";
import { PullRequestService } from "../service";
import type { PullRequestProvider, PullRequestRef } from "../provider";
import { githubPr, githubProvider } from "../../../external/github/tests/support/github";

const ref: PullRequestRef = { provider: "github", owner: "acme", repository: "app", number: 12 };
const git = {
  remotes: async () => [{ name: "origin", url: "https://github.com/acme/app" }],
  branch: async () => "topic",
};

test("service resolves branch searches before exact lookup", async () => {
  const { provider } = githubProvider((url) =>
    Response.json(url.pathname.endsWith("/pulls") ? [githubPr()] : githubPr()),
  );
  const create = mock(async () => provider);
  const service = new PullRequestService(git, create);

  expect((await service.show({})).ref).toEqual(ref);
  expect(create).toHaveBeenCalledTimes(1);
});

test.each([0, 2])("branch search with %i candidates does not select a PR", async (count) => {
  const getPullRequest = mock(async () => {
    throw new Error("must not fetch");
  });
  const provider: PullRequestProvider = {
    getPullRequest,
    findOpenPullRequests: async () =>
      Array.from({ length: count }, (_, index) => ({ ...ref, number: index + 1 })),
    getChecks: async () => [],
    getReviews: async () => [],
  };
  const service = new PullRequestService(git, async () => provider);

  await expect(service.show({})).rejects.toMatchObject({
    code: count === 0 ? "SCM_NOT_FOUND" : "SCM_AMBIGUOUS_PULL_REQUEST",
  });
  expect(getPullRequest).not.toHaveBeenCalled();
});

test("service validates URLs before creating an authenticated client", async () => {
  const create = mock(async (): Promise<PullRequestProvider> => {
    throw new Error("must not create");
  });
  const service = new PullRequestService(git, create);

  await expect(service.show({ ref: "https://evil.test/acme/app/pull/1" })).rejects.toMatchObject({
    code: "SCM_INVALID_URL",
  });
  expect(create).not.toHaveBeenCalled();
});
