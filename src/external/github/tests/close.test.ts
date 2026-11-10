import { expect, test } from "bun:test";
import { githubPr, githubProvider } from "./support/github";

const ref = { provider: "github" as const, owner: "acme", repository: "app", number: 12 };

test("closes the exact PR before adding the optional comment", async () => {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const { provider } = githubProvider((url, request) => {
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      ...(request.body ? { body: JSON.parse(String(request.body)) } : {}),
    });
    return Response.json(
      request.method === "POST"
        ? { id: 34 }
        : githubPr({ state: request.method === "PATCH" ? "closed" : "open" }),
    );
  });

  const pr = await provider.closePullRequest(ref, { comment: "Closing this test PR." });

  expect(pr.state).toBe("closed");
  expect(requests).toEqual([
    { method: "GET", path: "/repos/acme/app/pulls/12" },
    { method: "PATCH", path: "/repos/acme/app/pulls/12", body: { state: "closed" } },
    {
      method: "POST",
      path: "/repos/acme/app/issues/12/comments",
      body: { body: "Closing this test PR." },
    },
  ]);
});

test("close without a comment accepts canonical repository casing and only closes", async () => {
  const { provider, calls } = githubProvider((_, request) =>
    Response.json(githubPr({ state: request.method === "PATCH" ? "closed" : "open" })),
  );

  expect(
    (await provider.closePullRequest({ ...ref, owner: "ACME", repository: "App" })).ref,
  ).toEqual(ref);
  expect(calls).toHaveLength(2);
});

test.each(["closed", "merged"])("does not write or comment on a %s PR", async (state) => {
  const { provider, calls } = githubProvider(() =>
    Response.json(githubPr({ state: "closed", merged: state === "merged" })),
  );

  if (state === "closed")
    expect((await provider.closePullRequest(ref, { comment: "Do not duplicate" })).state).toBe(
      "closed",
    );
  else
    await expect(provider.closePullRequest(ref, { comment: "Do not post" })).rejects.toMatchObject({
      code: "SCM_INVALID_STATE",
    });
  expect(calls).toHaveLength(1);
});

test.each([
  githubPr({ number: 99 }),
  githubPr({ base: { ref: "main", repo: { owner: { login: "other" }, name: "app" } } }),
  githubPr({ title: null }),
])("rejects unverifiable preflight before writes %#", async (response) => {
  const { provider, calls } = githubProvider(() => Response.json(response));

  await expect(provider.closePullRequest(ref, { comment: "Do not post" })).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
  expect(calls).toHaveLength(1);
});

test.each([githubPr({ number: 99, state: "closed" }), githubPr(), githubPr({ title: null })])(
  "does not comment when the close response is unverifiable %#",
  async (response) => {
    const { provider, calls } = githubProvider((_, request) =>
      Response.json(request.method === "PATCH" ? response : githubPr()),
    );

    await expect(provider.closePullRequest(ref, { comment: "Do not post" })).rejects.toMatchObject({
      code: "SCM_PARTIAL_FAILURE",
      message: expect.stringContaining("https://github.com/acme/app/pull/12"),
    });
    expect(calls).toHaveLength(2);
  },
);

test.each(["denied", "malformed", "disconnected"])(
  "reports closure and possible comment failure when comment is %s without retrying",
  async (mode) => {
    const { provider, calls } = githubProvider((_, request) => {
      if (request.method === "POST") {
        if (mode === "disconnected") throw new Error("secret-token");
        return Response.json({}, { status: mode === "denied" ? 403 : 200 });
      }
      return Response.json(githubPr({ state: request.method === "PATCH" ? "closed" : "open" }));
    });

    await expect(provider.closePullRequest(ref, { comment: "Closing" })).rejects.toMatchObject({
      code: "SCM_PARTIAL_FAILURE",
      message: expect.stringContaining("PR closed: https://github.com/acme/app/pull/12"),
    });
    expect(calls).toHaveLength(3);
  },
);

test("a denied close is structured and does not post a comment", async () => {
  const { provider, calls } = githubProvider((_, request) =>
    request.method === "PATCH"
      ? Response.json({ message: "secret-token" }, { status: 403 })
      : Response.json(githubPr()),
  );

  await expect(provider.closePullRequest(ref, { comment: "Do not post" })).rejects.toMatchObject({
    code: "SCM_ACCESS_DENIED",
    message: "The provider denied access to this operation.",
  });
  expect(calls).toHaveLength(2);
});

test("an interrupted close warns that the mutation may have applied and does not comment", async () => {
  const { provider, calls } = githubProvider((_, request) => {
    if (request.method === "PATCH") throw new Error("secret-token");
    return Response.json(githubPr());
  });

  await expect(provider.closePullRequest(ref, { comment: "Do not post" })).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
    message: expect.stringContaining("The PR may have closed:"),
  });
  expect(calls).toHaveLength(2);
});
