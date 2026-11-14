import { expect, test } from "bun:test";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import { githubProvider } from "./support/github";

const ref: PullRequestRef = { provider: "github", owner: "acme", repository: "app", number: 12 };

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

  const reviews = await provider.getReviews(ref);

  expect(reviews).toEqual([
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

  const reviews = await provider.getReviews(ref);

  expect(reviews).toEqual([
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

  const reviews = await provider.getReviews(ref);

  expect(reviews).toEqual([
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
