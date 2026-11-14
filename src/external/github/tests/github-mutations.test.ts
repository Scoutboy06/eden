import { expect, test } from "bun:test";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import { githubPr, githubProvider } from "./support/github";

const ref: PullRequestRef = { provider: "github", owner: "acme", repository: "app", number: 12 };

test("review requests send bare team slugs and confirm distinct user/team identities", async () => {
  let requested = false;
  const { provider, calls } = githubProvider((url, request) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/requested_reviewers") && request.method === "GET")
      return Response.json(
        requested
          ? { users: [{ id: 1, login: "security" }], teams: [{ id: 2, slug: "security" }] }
          : { users: [], teams: [] },
      );
    if (url.pathname.endsWith("/requested_reviewers") && request.method !== "GET") {
      expect(JSON.parse(String(request.body))).toMatchObject({
        reviewers: ["security"],
        team_reviewers: ["security"],
      });
      requested = true;
      return Response.json({ users: [], teams: [] });
    }
    throw new Error(`Unexpected ${url}`);
  });

  const result = await provider.requestReview(ref, {
    reviewers: ["security"],
    teams: ["security"],
  });
  const requestPaths = calls.map(({ pathname }) => pathname);

  expect(result).toEqual({ requested: ["security", "security"], alreadyPending: [] });
  expect(requestPaths).toEqual([
    "/repos/acme/app/pulls/12",
    "/repos/acme/app/pulls/12/requested_reviewers",
    "/repos/acme/app/pulls/12/requested_reviewers",
    "/repos/acme/app/pulls/12/requested_reviewers",
  ]);
});

test("review request rejects closed PRs and preserves definite access-denied errors", async () => {
  const closed = githubProvider(() => Response.json(githubPr({ state: "closed" })));
  await expect(
    closed.provider.requestReview(ref, { reviewers: ["alice"], teams: [] }),
  ).rejects.toMatchObject({ code: "SCM_INVALID_STATE" });
  expect(closed.calls).toHaveLength(1);

  const denied = githubProvider((url, request) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/requested_reviewers") && request.method === "GET")
      return Response.json({ users: [], teams: [] });

    return Response.json({ message: "denied" }, { status: 403 });
  });
  await expect(
    denied.provider.requestReview(ref, { reviewers: ["alice"], teams: [] }),
  ).rejects.toMatchObject({ code: "SCM_ACCESS_DENIED" });
});

test("review request confirmation failure is reported as possibly applied", async () => {
  const { provider } = githubProvider((url, request) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/requested_reviewers") && request.method === "GET")
      return Response.json({ users: [], teams: [] });
    if (url.pathname.endsWith("/requested_reviewers")) return Response.json({});
    throw new Error(`Unexpected ${url}`);
  });

  await expect(
    provider.requestReview(ref, { reviewers: ["alice"], teams: [] }),
  ).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
    message: expect.stringContaining("may have been applied"),
  });
});

test.each([
  [true, "convertPullRequestToDraft"],
  [false, "markPullRequestReadyForReview"],
] as const)(
  "draft transition %s uses GraphQL variables and authenticated Octokit",
  async (draft, mutation) => {
    let reads = 0;
    const { provider, calls } = githubProvider((url, request) => {
      if (url.pathname.endsWith("/graphql")) {
        expect(request.headers).toMatchObject({ authorization: "token test-secret" });
        const body = JSON.parse(String(request.body));
        expect(body.query).toContain(mutation);
        expect(body.variables).toEqual({ pullRequestId: "PR_node_12" });
        return Response.json({ data: { [mutation]: { pullRequest: { id: "PR_node_12" } } } });
      }

      reads++;
      return Response.json(githubPr({ draft: reads === 1 ? !draft : draft }));
    }, "test-secret");

    const result = await provider.editPullRequest(ref, { isDraft: draft });

    expect(result.isDraft).toBe(draft);
    expect(calls.map((call) => call.pathname)).toEqual([
      "/repos/acme/app/pulls/12",
      "/graphql",
      "/repos/acme/app/pulls/12",
    ]);
    expect(calls[0]?.pathname).toContain("/acme/app/");
  },
);

test("draft-only edit avoids REST update", async () => {
  const { provider, calls } = githubProvider((url) => {
    if (url.pathname.endsWith("/graphql"))
      return Response.json({
        data: { convertPullRequestToDraft: { pullRequest: { id: "PR_node_12" } } },
      });

    return Response.json(githubPr({ draft: false }));
  });

  await provider.editPullRequest(ref, { isDraft: true });

  const pullRequestRequests = calls.filter((call) => call.pathname === "/repos/acme/app/pulls/12");
  const graphqlRequests = calls.filter((call) => call.pathname.endsWith("/graphql"));

  expect(pullRequestRequests).toHaveLength(2);
  expect(graphqlRequests).toHaveLength(1);
});

test("REST field success followed by GraphQL failure reports partial application", async () => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/graphql"))
      return Response.json({ message: "failed" }, { status: 500 });
    if (url.pathname.endsWith("/pulls/12") && url.search === "")
      return Response.json(githubPr({ draft: true }));

    return Response.json(githubPr({ draft: true }));
  });

  await expect(
    provider.editPullRequest(ref, { title: "Changed", isDraft: false }),
  ).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
    message: expect.stringContaining(
      "Pull request fields were updated, but its draft state change failed. SCM_REQUEST_FAILED:",
    ),
  });
});

test.each([
  [401, "SCM_AUTHENTICATION_FAILED"],
  [403, "SCM_ACCESS_DENIED"],
  [429, "SCM_RATE_LIMITED"],
] as const)("draft-only transition preserves normalized HTTP %i failure", async (status, code) => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/graphql"))
      return Response.json({ message: "provider failure" }, { status });

    return Response.json(githubPr({ draft: false }));
  });

  await expect(provider.editPullRequest(ref, { isDraft: true })).rejects.toMatchObject({ code });
});

test("draft-only transition preserves invalid response for missing GraphQL node ID", async () => {
  const { provider, calls } = githubProvider(() =>
    Response.json(githubPr({ node_id: null, draft: false })),
  );

  await expect(provider.editPullRequest(ref, { isDraft: true })).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
  expect(calls).toHaveLength(1);
});

test("successful draft mutation followed by failed confirmation reports partial failure without repeating writes", async () => {
  let pullReads = 0;
  const { provider, calls } = githubProvider((url) => {
    if (url.pathname.endsWith("/graphql"))
      return Response.json({
        data: { convertPullRequestToDraft: { pullRequest: { id: "PR_node_12" } } },
      });
    pullReads++;
    if (pullReads === 1) return Response.json(githubPr({ draft: false }));

    return Response.json({ message: "not found" }, { status: 404 });
  });

  await expect(provider.editPullRequest(ref, { isDraft: true })).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
    message: expect.stringContaining("SCM_NOT_FOUND:"),
  });
  const graphqlRequests = calls.filter((call) => call.pathname.endsWith("/graphql"));
  const pullRequestRequests = calls.filter((call) => call.pathname === "/repos/acme/app/pulls/12");

  expect(graphqlRequests).toHaveLength(1);
  expect(pullRequestRequests).toHaveLength(2);
});

test("create and update failures normalize provider responses", async () => {
  const { provider } = githubProvider((_url, request) =>
    Response.json({ message: "bad request" }, { status: request.method === "POST" ? 422 : 403 }),
  );
  const createInput = {
    repository: { provider: "github" as const, owner: "acme", repository: "app" },
    title: "Title",
    body: "",
    sourceBranch: "topic",
    targetBranch: "main",
    draft: false,
  };

  await expect(provider.createPullRequest(createInput)).rejects.toMatchObject({
    code: "SCM_INVALID_REQUEST",
  });
  await expect(provider.editPullRequest(ref, { title: "Changed" })).rejects.toMatchObject({
    code: "SCM_ACCESS_DENIED",
  });
});
