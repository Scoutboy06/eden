import { expect, test } from "bun:test";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import { githubPr, githubProvider } from "./support/github";

const ref: PullRequestRef = { provider: "github", owner: "acme", repository: "app", number: 12 };

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
  expect(calls.some((url) => url.pathname.includes("/abc/"))).toBe(true);
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
    { reviewer: { id: "user:3", name: "charlie" }, state: "pending" },
    { reviewer: { id: "team:8", name: "security" }, state: "pending" },
  ]);
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
