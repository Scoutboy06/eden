import { expect, test } from "bun:test";
import type { PullRequestListQuery } from "../../../modules/pull-requests/provider";
import { githubPr, githubProvider } from "./support/github";

const query: PullRequestListQuery = {
  repository: { provider: "github", owner: "acme", repository: "app" },
  state: "open",
  limit: 30,
};

function item(number: number, overrides: Record<string, unknown> = {}) {
  return githubPr({
    number,
    html_url: `https://github.com/acme/app/pull/${number}`,
    merged_at: null,
    user: { id: 7, login: "Alice" },
    ...overrides,
  });
}

test.each([
  ["open", "open", [1]],
  ["closed", "closed", [2]],
  ["merged", "closed", [3]],
  ["all", "all", [1, 2, 3]],
] as const)(
  "lists %s with correct server state and distinct merged normalization",
  async (state, serverState, numbers) => {
    const { provider, calls } = githubProvider(() =>
      Response.json([
        item(1),
        item(2, { state: "closed" }),
        item(3, { state: "closed", merged_at: "2026-11-10T00:00:00Z" }),
      ]),
    );

    const result = await provider.listPullRequests({ ...query, state });

    expect(result.map((pr) => (pr.ref.provider === "github" ? pr.ref.number : 0))).toEqual([
      ...numbers,
    ]);
    expect(calls[0]?.searchParams.get("state")).toBe(serverState);
    expect(calls[0]?.searchParams.get("sort")).toBe("created");
    expect(calls[0]?.searchParams.get("direction")).toBe("desc");
    if (state === "merged") expect(result[0]?.state).toBe("merged");
  },
);

test("author and draft filtering continue across pages until matching limit, then stop", async () => {
  const { provider, calls } = githubProvider((url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    const pages = [
      [item(1, { user: { id: 8, login: "bob" } }), item(2, { draft: false })],
      [item(3), item(4, { user: null })],
      [item(5), item(6)],
    ];
    return Response.json(pages[page - 1] ?? [], {
      headers: {
        link: `<https://api.github.com/repos/acme/app/pulls?page=${page + 1}>; rel="next"`,
      },
    });
  });

  const result = await provider.listPullRequests({
    ...query,
    author: "alice",
    draft: true,
    limit: 2,
  });

  expect(result.map((pr) => pr.url)).toEqual([
    "https://github.com/acme/app/pull/3",
    "https://github.com/acme/app/pull/5",
  ]);
  expect(result[0]?.author).toEqual({ id: "user:7", name: "Alice" });
  expect(calls).toHaveLength(3);
  expect(calls[0]?.searchParams.get("per_page")).toBe("2");
});

test("missing authors remain null and nondraft filtering is supported by the adapter", async () => {
  const { provider } = githubProvider(() =>
    Response.json([item(1, { user: null, draft: false }), item(2)]),
  );

  const result = await provider.listPullRequests({ ...query, draft: false });

  expect(result).toHaveLength(1);
  expect(result[0]?.author).toBeNull();
});

test("empty lists return no PRs", async () => {
  const { provider } = githubProvider(() => Response.json([]));

  expect(await provider.listPullRequests(query)).toEqual([]);
});

test.each([
  {},
  item(0),
  item(1, { merged_at: undefined }),
  item(1, { base: { ref: "main", repo: { owner: { login: "other" }, name: "app" } } }),
])("rejects malformed or mismatched list items %#", async (data) => {
  const { provider } = githubProvider(() => Response.json([data]));

  await expect(provider.listPullRequests(query)).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
});

test("provider failures are structured and do not expose server diagnostics", async () => {
  const { provider } = githubProvider(() =>
    Response.json({ message: "secret-token" }, { status: 403 }),
  );

  await expect(provider.listPullRequests(query)).rejects.toMatchObject({
    code: "SCM_ACCESS_DENIED",
    message: "The provider denied access to this operation.",
  });
});
