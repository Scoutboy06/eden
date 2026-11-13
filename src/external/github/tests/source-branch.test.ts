import { expect, test } from "bun:test";
import { githubPr, githubProvider } from "./support/github";

test("finds open, closed and merged PRs associated with an exact source branch", async () => {
  const { provider, calls } = githubProvider((_url) =>
    Response.json([
      githubPr({ number: 12, head: { ref: "topic" } }),
      githubPr({
        number: 13,
        state: "closed",
        merged: false,
        head: { ref: "topic" },
      }),
      githubPr({
        number: 14,
        state: "closed",
        merged: true,
        merged_at: "2026-11-10T00:00:00Z",
        head: { ref: "topic" },
      }),
      githubPr({ number: 15, head: { ref: "other" } }),
    ]),
  );

  const refs = await provider.findPullRequestsBySourceBranch({
    repository: { provider: "github", owner: "acme", repository: "app" },
    sourceBranch: "topic",
  });

  expect(refs).toEqual([
    { provider: "github", owner: "acme", repository: "app", number: 12 },
    { provider: "github", owner: "acme", repository: "app", number: 13 },
    { provider: "github", owner: "acme", repository: "app", number: 14 },
  ]);
  expect(calls[0]?.searchParams.get("state")).toBe("all");
  expect(calls[0]?.searchParams.get("head")).toBe("acme:topic");
});
