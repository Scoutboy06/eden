import { expect, test } from "bun:test";
import { githubPr, githubProvider } from "./support/github";

const input = {
  repository: { provider: "github" as const, owner: "acme", repository: "app" },
  title: "Title",
  body: "",
  sourceBranch: "topic",
  targetBranch: "main",
  draft: true,
  reviewers: ["alice"],
  labels: ["bug"],
};

test("creates then applies reviewers and labels to the created PR", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const { provider } = githubProvider((url, request) => {
    requests.push({ path: url.pathname, body: JSON.parse(String(request.body)) });
    return Response.json(githubPr());
  });

  const pr = await provider.createPullRequest(input);

  expect(pr.url).toBe("https://github.com/acme/app/pull/12");
  expect(requests).toEqual([
    {
      path: "/repos/acme/app/pulls",
      body: { title: "Title", body: "", head: "topic", base: "main", draft: true },
    },
    { path: "/repos/acme/app/pulls/12/requested_reviewers", body: { reviewers: ["alice"] } },
    { path: "/repos/acme/app/issues/12/labels", body: { labels: ["bug"] } },
  ]);
});

test.each(["requested_reviewers", "labels"])(
  "reports created PR and does not retry when %s fails",
  async (endpoint) => {
    const { provider, calls } = githubProvider((url) =>
      url.pathname.endsWith(endpoint)
        ? Response.json({ message: "secret-token" }, { status: 422 })
        : Response.json(githubPr()),
    );

    await expect(provider.createPullRequest(input)).rejects.toMatchObject({
      code: "SCM_PARTIAL_FAILURE",
      message: expect.stringContaining("PR created: https://github.com/acme/app/pull/12"),
    });
    expect(calls.filter((url) => url.pathname.endsWith("/pulls"))).toHaveLength(1);
  },
);

test.each([
  {},
  githubPr({ number: 0 }),
  githubPr({ base: { ref: "main", repo: { owner: { login: "other" }, name: "repo" } } }),
  githubPr({ html_url: "https://evil.test/12" }),
])("does not apply metadata after an unverifiable creation response %#", async (response) => {
  const { provider, calls } = githubProvider(() => Response.json(response));

  await expect(provider.createPullRequest(input)).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
  });
  expect(calls).toHaveLength(1);
});
