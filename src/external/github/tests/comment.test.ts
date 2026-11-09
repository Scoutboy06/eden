import { expect, test } from "bun:test";
import { githubPr, githubProvider } from "./support/github";

const ref = { provider: "github" as const, owner: "acme", repository: "app", number: 12 };
const root = { id: 56, pull_request_url: "https://api.github.com/repos/acme/app/pulls/12" };

function comment(reply = false, overrides: Record<string, unknown> = {}) {
  return {
    id: 34,
    body: "Comment body",
    user: { id: 7, login: "alice" },
    created_at: "2026-11-10T00:00:00Z",
    html_url: `https://github.com/acme/app/pull/12#${reply ? "discussion_r" : "issuecomment-"}34`,
    ...(reply
      ? { pull_request_url: root.pull_request_url, in_reply_to_id: 56 }
      : { issue_url: "https://api.github.com/repos/acme/app/issues/12" }),
    ...overrides,
  };
}

test.each([false, true])(
  "posts a %s review reply using the exact endpoint and returns its identity",
  async (reply) => {
    const requests: { path: string; method: string; body?: unknown }[] = [];
    const { provider } = githubProvider((url, request) => {
      requests.push({
        path: url.pathname,
        method: request.method ?? "GET",
        ...(request.body ? { body: JSON.parse(String(request.body)) } : {}),
      });
      return Response.json(
        request.method === "POST"
          ? comment(reply)
          : url.pathname.endsWith("/pulls/comments/56")
            ? root
            : githubPr(),
      );
    });

    const result = await provider.addComment(ref, {
      body: "Comment body",
      ...(reply ? { replyTo: "review:56" } : {}),
    });

    expect(result).toMatchObject({
      id: `${reply ? "review" : "issue"}:34`,
      body: "Comment body",
      author: { name: "alice" },
      ...(reply ? { threadId: "56" } : {}),
    });
    expect(requests).toEqual([
      { path: "/repos/acme/app/pulls/12", method: "GET" },
      ...(reply ? [{ path: "/repos/acme/app/pulls/comments/56", method: "GET" }] : []),
      {
        path: reply
          ? "/repos/acme/app/pulls/12/comments/56/replies"
          : "/repos/acme/app/issues/12/comments",
        method: "POST",
        body: { body: "Comment body" },
      },
    ]);
  },
);

test.each([
  githubPr({ number: 99 }),
  githubPr({ base: { ref: "main", repo: { owner: { login: "other" }, name: "app" } } }),
])("rejects mismatched PR preflight before posting %#", async (data) => {
  const { provider, calls } = githubProvider(() => Response.json(data));

  await expect(provider.addComment(ref, { body: "No post" })).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
  expect(calls).toHaveLength(1);
});

test.each([
  [{ ...root, id: 57 }, "SCM_INVALID_REFERENCE"],
  [
    { ...root, pull_request_url: "https://api.github.com/repos/acme/app/pulls/99" },
    "SCM_INVALID_REFERENCE",
  ],
  [{ ...root, in_reply_to_id: 55 }, "SCM_UNSUPPORTED_OPERATION"],
] as const)(
  "validates reply membership and root target before posting %#",
  async (target, code) => {
    const { provider, calls } = githubProvider((url) =>
      Response.json(url.pathname.endsWith("/pulls/comments/56") ? target : githubPr()),
    );

    await expect(
      provider.addComment(ref, { body: "No post", replyTo: "review:56" }),
    ).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(2);
  },
);

test("unsupported discussion replies fail before any requests", async () => {
  const { provider, calls } = githubProvider(() => {
    throw new Error("No request expected");
  });

  await expect(
    provider.addComment(ref, { body: "No post", replyTo: "issue:56" }),
  ).rejects.toMatchObject({ code: "SCM_UNSUPPORTED_OPERATION" });
  expect(calls).toEqual([]);
});

test.each([
  {},
  comment(false, { id: 0 }),
  comment(false, { issue_url: "https://api.github.com/repos/acme/app/issues/99" }),
  comment(false, { html_url: "https://evil.test/comment" }),
  comment(false, { body: null }),
])("reports possibly posted comment on unverifiable success %#", async (response) => {
  const { provider, calls } = githubProvider((_, request) =>
    Response.json(request.method === "POST" ? response : githubPr()),
  );

  await expect(provider.addComment(ref, { body: "Comment body" })).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
    message: expect.stringContaining("Inspect the PR before retrying"),
  });
  expect(calls).toHaveLength(2);
});

test("reply confirmation must match its root comment", async () => {
  const { provider, calls } = githubProvider((url, request) =>
    Response.json(
      request.method === "POST"
        ? comment(true, { in_reply_to_id: 99 })
        : url.pathname.endsWith("/pulls/comments/56")
          ? root
          : githubPr(),
    ),
  );

  await expect(
    provider.addComment(ref, { body: "Comment body", replyTo: "review:56" }),
  ).rejects.toMatchObject({ code: "SCM_PARTIAL_FAILURE" });
  expect(calls).toHaveLength(3);
});

test("denied comments are structured and do not expose provider diagnostics", async () => {
  const { provider, calls } = githubProvider((_, request) =>
    request.method === "POST"
      ? Response.json({ message: "secret-token" }, { status: 403 })
      : Response.json(githubPr()),
  );

  await expect(provider.addComment(ref, { body: "Comment body" })).rejects.toMatchObject({
    code: "SCM_ACCESS_DENIED",
    message: "The provider denied access to this operation.",
  });
  expect(calls).toHaveLength(2);
});

test("lost post response warns of duplicate risk without retrying", async () => {
  const { provider, calls } = githubProvider((_, request) => {
    if (request.method === "POST") throw new Error("secret-token");
    return Response.json(githubPr());
  });

  await expect(provider.addComment(ref, { body: "Comment body" })).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
    message: expect.stringContaining("avoid duplicate comments"),
  });
  expect(calls).toHaveLength(2);
});
