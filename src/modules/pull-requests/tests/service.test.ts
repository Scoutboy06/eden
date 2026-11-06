import { expect, mock, test } from "bun:test";
import { PullRequestService } from "../service";
import type { PullRequestProvider, PullRequestRef } from "../provider";
import { githubPr, githubProvider } from "../../../external/github/tests/support/github";
import { azureProvider } from "../../../external/azure-devops/tests/support/azure";

const ref: PullRequestRef = { provider: "github", owner: "acme", repository: "app", number: 12 };
const git = {
  remotes: async () => [{ name: "origin", url: "https://github.com/acme/app" }],
  branch: async () => "topic",
};

test("service resolves branch searches before exact lookup", async () => {
  const selected = { ...ref, number: 37 };
  const calls: string[] = [];
  const { provider } = githubProvider(() => Response.json(githubPr()));
  provider.findOpenPullRequests = mock(async (query) => {
    expect(query).toEqual({
      repository: { provider: "github", owner: "acme", repository: "app" },
      sourceBranch: "topic",
    });
    calls.push("search");

    return [selected];
  });
  provider.getPullRequest = mock(async (lookup) => {
    expect(lookup).toEqual(selected);
    calls.push("fetch");

    return {
      ref: selected,
      url: "https://github.com/acme/app/pull/37",
      title: "Selected PR",
      body: "",
      state: "open" as const,
      isDraft: false,
      sourceBranch: "topic",
      targetBranch: "main",
    };
  });
  const create = mock(async () => provider);
  const service = new PullRequestService(git, create);

  expect((await service.show({})).ref).toEqual(selected);
  expect(calls).toEqual(["search", "fetch"]);
  expect(provider.findOpenPullRequests).toHaveBeenCalledTimes(1);
  expect(provider.getPullRequest).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith({ provider: "github", owner: "acme", repository: "app" });
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

test("reviewer filters use effective GitHub requests and decisions", async () => {
  const { provider } = githubProvider((url) =>
    url.pathname.endsWith("/requested_reviewers")
      ? Response.json({ users: [{ id: 2, login: "bob" }], teams: [{ id: 4, slug: "security" }] })
      : Response.json([
          { id: 1, user: { id: 1, login: "alice" }, state: "APPROVED" },
          { id: 2, user: { id: 2, login: "bob" }, state: "APPROVED" },
          { id: 3, user: { id: 3, login: "charlie" }, state: "DISMISSED" },
        ]),
  );
  const service = new PullRequestService(git, async () => provider);

  expect((await service.reviewers({ ref: "12" })).reviews).toHaveLength(4);
  expect(
    (await service.reviewers({ ref: "12", pending: true })).reviews.map(
      (review) => review.reviewer.id,
    ),
  ).toEqual(["user:2", "team:4"]);
  expect(
    (await service.reviewers({ ref: "12", approved: true })).reviews.map(
      (review) => review.reviewer.id,
    ),
  ).toEqual(["user:1"]);
});

test("Azure approved includes positive votes with suggestions, not negative or absent votes", async () => {
  const provider = azureProvider({
    getPullRequestReviewers: async () =>
      [10, 5, 0, -5, -10, 99].map((vote) => ({
        id: String(vote),
        displayName: `Reviewer ${vote}`,
        vote,
      })),
  });
  const service = new PullRequestService(git, async () => provider);
  const input = { ref: "https://dev.azure.com/acme/Product/_git/app/pullrequest/42" };

  expect(
    (await service.reviewers({ ...input, approved: true })).reviews.map((review) => review.state),
  ).toEqual(["approved", "approved-with-suggestions"]);
  expect(
    (await service.reviewers({ ...input, pending: true })).reviews.map((review) => review.state),
  ).toEqual(["pending"]);
  expect((await service.reviewers(input)).reviews).toHaveLength(6);
});

test("reviewer filters reject conflicting options before accessing credentials", async () => {
  const create = mock(async () => azureProvider());
  const service = new PullRequestService(git, create);

  await expect(service.reviewers({ pending: true, approved: true })).rejects.toMatchObject({
    code: "SCM_INVALID_OPTIONS",
  });
  expect(create).not.toHaveBeenCalled();
});

test("reviewer filters preserve empty results", async () => {
  const service = new PullRequestService(git, async () => azureProvider());
  const input = { ref: "https://dev.azure.com/acme/Product/_git/app/pullrequest/42" };

  expect((await service.reviewers({ ...input, pending: true })).reviews).toEqual([]);
  expect((await service.reviewers({ ...input, approved: true })).reviews).toEqual([]);
});

test("checks watch resolves a branch only once and forwards required-only on each poll", async () => {
  const { provider } = githubProvider(() => Response.json([githubPr()]));
  const find = mock(provider.findOpenPullRequests.bind(provider));
  let calls = 0;
  const getChecks = mock(async () => [
    {
      id: "build",
      name: "Build",
      state: ++calls === 1 ? ("pending" as const) : ("passed" as const),
    },
  ]);
  provider.findOpenPullRequests = find;
  provider.getChecks = getChecks;
  const service = new PullRequestService(git, async () => provider);

  expect(
    await service.checks({ watch: true, requiredOnly: true }, { intervalMs: 1 }),
  ).toMatchObject({ ref, checks: [{ state: "passed" }] });
  expect(find).toHaveBeenCalledTimes(1);
  expect(getChecks.mock.calls).toHaveLength(2);
  expect(getChecks).toHaveBeenCalledWith(ref, {
    requiredOnly: true,
    signal: expect.any(AbortSignal),
  });
});

test("status resolves once and reads fresh PR, reviews and checks on every invocation", async () => {
  const { provider } = githubProvider(() => Response.json(githubPr()));
  const find = mock(async () => [ref]);
  const getPr = mock(provider.getPullRequest.bind(provider));
  const getReviews = mock(async () => []);
  const getChecks = mock(async () => []);
  provider.findOpenPullRequests = find;
  provider.getPullRequest = getPr;
  provider.getReviews = getReviews;
  provider.getChecks = getChecks;
  const service = new PullRequestService(git, async () => provider);

  expect(await service.status({})).toMatchObject({ pr: { ref }, reviews: [], checks: [] });
  expect(find).toHaveBeenCalledTimes(1);
  await service.status({ ref: "12" });

  for (const read of [getPr, getReviews, getChecks]) {
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith(ref);
  }
});

test.each([0, 2])(
  "status preserves missing/ambiguous branch errors (%i matches)",
  async (count) => {
    const { provider } = githubProvider(() => Response.json(githubPr()));
    provider.findOpenPullRequests = async () =>
      Array.from({ length: count }, (_, index) => ({ ...ref, number: index + 1 }));
    const read = mock(async () => []);
    provider.getChecks = read;
    const service = new PullRequestService(git, async () => provider);

    await expect(service.status({})).rejects.toMatchObject({
      code: count === 0 ? "SCM_NOT_FOUND" : "SCM_AMBIGUOUS_PULL_REQUEST",
    });
    expect(read).not.toHaveBeenCalled();
  },
);

test("status fails rather than reporting incomplete successful status when a provider read fails", async () => {
  const { provider } = githubProvider((url) =>
    url.pathname.endsWith("/pulls/12")
      ? Response.json(githubPr())
      : Response.json({}, { status: 403 }),
  );
  const service = new PullRequestService(git, async () => provider);

  await expect(service.status({ ref: "12" })).rejects.toMatchObject({ code: "SCM_ACCESS_DENIED" });
});
