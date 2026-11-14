import { expect, test } from "bun:test";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import { githubPr, githubProvider } from "./support/github";

const ref: PullRequestRef = { provider: "github", owner: "acme", repository: "app", number: 12 };

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

  const comments = await provider.getComments(ref);

  expect(comments).toMatchObject([
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
