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

test("show fetches optional enrichments only on request", async () => {
  const getComments = mock(async () => []);
  const getChecks = mock(async () => []);
  const { provider } = githubProvider(() => Response.json(githubPr()));
  provider.getComments = getComments;
  provider.getChecks = getChecks;
  const service = new PullRequestService(git, async () => provider);

  const basic = await service.show({ ref: "12" });

  expect(basic).not.toHaveProperty("comments");
  expect(basic).not.toHaveProperty("checks");
  expect(basic).not.toHaveProperty("raw");
  expect(getComments).not.toHaveBeenCalled();
  expect(getChecks).not.toHaveBeenCalled();

  const enriched = await service.show({ ref: "12", comments: true, checks: true, raw: true });

  expect(enriched).toMatchObject({ comments: [], checks: [], raw: { number: 12 } });
  expect(getComments).toHaveBeenCalledWith(ref);
  expect(getChecks).toHaveBeenCalledWith(ref);
});

test("show enrichment failures fail the command instead of silently omitting data", async () => {
  const { provider } = githubProvider((url) =>
    url.pathname.endsWith("/pulls/12")
      ? Response.json(githubPr())
      : Response.json({}, { status: 403 }),
  );
  const service = new PullRequestService(git, async () => provider);

  await expect(service.show({ ref: "12", comments: true })).rejects.toMatchObject({
    code: "SCM_ACCESS_DENIED",
  });
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
    getComments: async () => [],
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
