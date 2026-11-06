import { expect, test } from "bun:test";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import { githubPr, githubProvider } from "./support/github";

const ref: PullRequestRef = { provider: "github", owner: "acme", repository: "app", number: 12 };

test("raw PR fields are opt-in and preserve provider-specific data", async () => {
  const { provider } = githubProvider(() => Response.json(githubPr({ mergeable: true })));

  expect((await provider.getPullRequest(ref)).raw).toBeUndefined();
  expect((await provider.getPullRequest(ref, { raw: true })).raw).toMatchObject({
    mergeable: true,
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

  expect(calls.filter((call) => call.pathname === "/repos/acme/app/pulls/12")).toHaveLength(2);
  expect(calls.filter((call) => call.pathname.endsWith("/graphql"))).toHaveLength(1);
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
  expect(calls.filter((call) => call.pathname.endsWith("/graphql"))).toHaveLength(1);
  expect(calls.filter((call) => call.pathname === "/repos/acme/app/pulls/12")).toHaveLength(2);
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

test("comments combine paginated discussion and inline replies in date order", async () => {
  const { provider, calls } = githubProvider((url) => {
    if (url.pathname.includes("/issues/")) {
      if (url.searchParams.get("page") === "2")
        return Response.json([{ id: 2, body: "Later", user: null, created_at: "2026-01-03" }]);

      return Response.json(
        [{ id: 1, body: "Discussion", user: { id: 7, login: "alice" }, created_at: "2026-01-01" }],
        {
          headers: {
            link: '<https://api.github.com/repos/acme/app/issues/12/comments?page=2>; rel="next"',
          },
        },
      );
    }

    return Response.json([
      {
        id: 3,
        body: "Inline",
        user: { id: 8, login: "bob" },
        path: "app.ts",
        line: 4,
        in_reply_to_id: 9,
        created_at: "2026-01-02",
      },
    ]);
  });

  expect(await provider.getComments(ref)).toMatchObject([
    { id: "issue:1", body: "Discussion", author: { name: "alice" } },
    { id: "review:3", path: "app.ts", line: 4, threadId: "9" },
    { id: "issue:2", author: null },
  ]);
  expect(calls).toHaveLength(3);
});

test("absent comments produce an empty list", async () => {
  const { provider } = githubProvider(() => Response.json([]));

  expect(await provider.getComments(ref)).toEqual([]);
});

test.each([
  [{ state: "open", merged: false }, "open"],
  [{ state: "closed", merged: false }, "closed"],
  [{ state: "closed", merged: true }, "merged"],
] as const)("maps GitHub PR lifecycle and core fields", async (overrides, state) => {
  const { provider } = githubProvider(() => Response.json(githubPr(overrides)));

  expect(await provider.getPullRequest(ref)).toEqual({
    ref,
    url: "https://github.com/acme/app/pull/12",
    title: "Improve login",
    body: "",
    state,
    isDraft: true,
    sourceBranch: "topic",
    targetBranch: "main",
  });
});

test("branch discovery paginates and retains ambiguity across fork heads", async () => {
  const { provider, calls } = githubProvider((url) => {
    if (url.searchParams.get("page") === "2")
      return Response.json([
        githubPr({ number: 13 }),
        githubPr({ number: 14, head: { ref: "unrelated" } }),
      ]);

    return Response.json([githubPr()], {
      headers: { link: '<https://api.github.com/repos/acme/app/pulls?page=2>; rel="next"' },
    });
  });

  expect(
    await provider.findOpenPullRequests({
      repository: { provider: "github", owner: "acme", repository: "app" },
      sourceBranch: "topic",
    }),
  ).toEqual([ref, { ...ref, number: 13 }]);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.searchParams.get("state")).toBe("open");
});

test("checks combine CI runs and latest legacy commit statuses", async () => {
  const { provider, calls } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({
        total_count: 3,
        check_runs: [
          {
            id: 1,
            name: "build",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/build",
          },
          { id: 2, name: "test", status: "in_progress", conclusion: null },
          { id: 3, name: "optional", status: "completed", conclusion: "neutral" },
        ],
      });

    return Response.json([
      { id: 9, context: "external", state: "success" },
      { id: 8, context: "external", state: "failure" },
    ]);
  });

  expect(await provider.getChecks(ref)).toEqual([
    { id: "check:1", name: "build", state: "passed", url: "https://github.com/build" },
    { id: "check:2", name: "test", state: "running" },
    { id: "check:3", name: "optional", state: "skipped" },
    { id: "status:9", name: "external", state: "passed" },
  ]);
  expect(calls).toHaveLength(3);
  expect(
    calls.map((url) => ({ path: url.pathname, query: Object.fromEntries(url.searchParams) })),
  ).toEqual(
    expect.arrayContaining([
      { path: "/repos/acme/app/pulls/12", query: {} },
      {
        path: "/repos/acme/app/commits/abc/check-runs",
        query: { per_page: "100", filter: "latest" },
      },
      { path: "/repos/acme/app/commits/abc/statuses", query: { per_page: "100" } },
    ]),
  );
});

test("required checks combine classic protection and rulesets, retaining missing requirements", async () => {
  const { provider, calls } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/protection"))
      return Response.json({
        required_status_checks: {
          contexts: ["build", "legacy"],
          checks: [{ context: "build", app_id: 7 }],
        },
      });
    if (url.pathname.includes("/rules/branches/"))
      return Response.json([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "build", integration_id: 7 },
              { context: "missing" },
            ],
          },
        },
      ]);
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({
        total_count: 3,
        check_runs: [
          { id: 1, name: "build", app: { id: 8 }, status: "completed", conclusion: "success" },
          { id: 2, name: "build", app: { id: 7 }, status: "in_progress" },
          { id: 3, name: "optional", status: "completed", conclusion: "failure" },
        ],
      });

    return Response.json([{ id: 4, context: "legacy", state: "success" }]);
  });

  expect(await provider.getChecks(ref, { requiredOnly: true })).toEqual([
    { id: "check:2", name: "build", state: "running" },
    { id: "status:4", name: "legacy", state: "passed" },
    { id: "required:missing:any", name: "missing", state: "pending" },
  ]);
  expect(calls.some((url) => url.pathname.endsWith("/branches/main/protection"))).toBe(true);
});

test("unprotected branches have no required checks", async () => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/protection")) return Response.json({}, { status: 404 });
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: 0, check_runs: [] });

    return Response.json([]);
  });

  expect(await provider.getChecks(ref, { requiredOnly: true })).toEqual([]);
});

test("GitHub checks forward cancellation to every SDK request", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const controller = new AbortController();
  const { provider } = githubProvider((url, request) => {
    signals.push(request.signal);
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/protection")) return Response.json({});
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: 0, check_runs: [] });

    return Response.json([]);
  });

  await provider.getChecks(ref, { requiredOnly: true, signal: controller.signal });

  expect(signals).toHaveLength(5);
  expect(signals.map((signal) => signal?.aborted ?? "missing")).toEqual([
    false,
    false,
    false,
    false,
    false,
  ]);

  controller.abort();

  expect(signals.every((signal) => signal?.aborted)).toBe(true);
});

test.each([403, 500])("required-check discovery fails explicitly on HTTP %i", async (status) => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/protection")) return Response.json({}, { status });
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: 0, check_runs: [] });

    return Response.json([]);
  });

  await expect(provider.getChecks(ref, { requiredOnly: true })).rejects.toMatchObject({
    code: status === 403 ? "SCM_ACCESS_DENIED" : "SCM_REQUEST_FAILED",
  });
});

test("required workflow rules report the unsupported projection explicitly", async () => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/protection")) return Response.json({});
    if (url.pathname.includes("/rules/branches/")) return Response.json([{ type: "workflows" }]);
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: 0, check_runs: [] });

    return Response.json([]);
  });

  await expect(provider.getChecks(ref, { requiredOnly: true })).rejects.toMatchObject({
    code: "SCM_UNSUPPORTED_OPERATION",
  });
});

test("reviews preserve effective decisions and outstanding user/team requests", async () => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/requested_reviewers"))
      return Response.json({
        users: [{ id: 2, login: "bob" }],
        teams: [{ id: 8, slug: "security" }],
      });

    return Response.json([
      { id: 1, user: { id: 1, login: "alice" }, state: "APPROVED" },
      { id: 2, user: { id: 1, login: "alice" }, state: "COMMENTED" },
      { id: 3, user: { id: 2, login: "bob" }, state: "CHANGES_REQUESTED" },
      { id: 4, user: { id: 3, login: "charlie" }, state: "APPROVED" },
      { id: 5, user: { id: 3, login: "charlie" }, state: "DISMISSED" },
      { id: 6, user: null, state: "COMMENTED" },
    ]);
  });

  expect(await provider.getReviews(ref)).toEqual([
    { reviewer: { id: "user:1", name: "alice" }, state: "approved" },
    { reviewer: { id: "user:2", name: "bob" }, state: "pending" },
    { reviewer: { id: "user:3", name: "charlie" }, state: "dismissed" },
    { reviewer: { id: "team:8", name: "security" }, state: "pending" },
  ]);
});

test("review requests override prior decisions and retain distinct team identities", async () => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/requested_reviewers"))
      return Response.json({
        users: [{ id: 1, login: "alice" }],
        teams: [{ id: 1, slug: "alice" }],
      });

    return Response.json([{ id: 1, user: { id: 1, login: "alice" }, state: "APPROVED" }]);
  });

  expect(await provider.getReviews(ref)).toEqual([
    { reviewer: { id: "user:1", name: "alice" }, state: "pending" },
    { reviewer: { id: "team:1", name: "alice" }, state: "pending" },
  ]);
});

test("review decisions paginate and ignore unpublished pending reviews", async () => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/requested_reviewers"))
      return Response.json({ users: [], teams: [] });
    if (url.searchParams.get("page") === "2")
      return Response.json([
        { id: 2, user: { id: 1, login: "alice" }, state: "CHANGES_REQUESTED" },
        { id: 3, user: { id: 2, login: "bob" }, state: "PENDING" },
      ]);

    return Response.json([{ id: 1, user: { id: 1, login: "alice" }, state: "APPROVED" }], {
      headers: {
        link: '<https://api.github.com/repos/acme/app/pulls/12/reviews?page=2>; rel="next"',
      },
    });
  });

  expect(await provider.getReviews(ref)).toEqual([
    { reviewer: { id: "user:1", name: "alice" }, state: "changes-requested" },
  ]);
});

test("absent GitHub reviews and requests return an empty list", async () => {
  const { provider } = githubProvider((url) =>
    Response.json(url.pathname.endsWith("/requested_reviewers") ? { users: [], teams: [] } : []),
  );

  expect(await provider.getReviews(ref)).toEqual([]);
});

test.each([
  [401, "SCM_AUTHENTICATION_FAILED"],
  [403, "SCM_ACCESS_DENIED"],
  [404, "SCM_NOT_FOUND"],
  [429, "SCM_RATE_LIMITED"],
  [500, "SCM_REQUEST_FAILED"],
])("maps SDK HTTP failure %i without exposing response secrets", async (status, code) => {
  const { provider } = githubProvider(() =>
    Response.json({ message: "secret-token" }, { status: status as number }),
  );

  await expect(provider.getPullRequest(ref)).rejects.toMatchObject({ code });
  await expect(provider.getPullRequest(ref)).rejects.not.toThrow("secret-token");
});

test("GitHub provider rejects Azure references before making a request", async () => {
  const { provider, calls } = githubProvider(() => {
    throw new Error("must not request");
  });

  await expect(
    provider.getPullRequest({
      provider: "azure-devops",
      organizationUrl: "https://dev.azure.com/acme",
      id: 1,
    }),
  ).rejects.toMatchObject({ code: "SCM_PROVIDER_MISMATCH" });
  expect(calls).toEqual([]);
});

test("incomplete GitHub SDK responses are rejected rather than returned as core PR data", async () => {
  const { provider } = githubProvider(() => Response.json({ state: "open" }));

  await expect(provider.getPullRequest(ref)).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
  await expect(provider.getChecks(ref)).rejects.toMatchObject({ code: "SCM_INVALID_RESPONSE" });
});
