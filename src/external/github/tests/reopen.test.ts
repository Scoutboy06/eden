import { expect, test } from "bun:test";
import { githubPr, githubProvider } from "./support/github";

const ref = { provider: "github" as const, owner: "acme", repository: "app", number: 12 };

test("GitHub reopens a closed PR through the exact repository and PR number", async () => {
  const writes: unknown[] = [];
  const { provider } = githubProvider((url, request) => {
    expect(url.pathname).toBe("/repos/acme/app/pulls/12");
    if (request.method === "PATCH") writes.push(JSON.parse(String(request.body)));

    return Response.json(githubPr({ state: request.method === "PATCH" ? "open" : "closed" }));
  });

  expect((await provider.reopenPullRequest(ref)).state).toBe("open");
  expect(writes).toEqual([{ state: "open" }]);
});

test.each(["open", "merged"])("GitHub does not mutate a %s PR when reopening", async (state) => {
  const { provider, calls } = githubProvider(() =>
    Response.json(
      githubPr({ state: state === "merged" ? "closed" : state, merged: state === "merged" }),
    ),
  );

  if (state === "open") expect((await provider.reopenPullRequest(ref)).state).toBe("open");
  else
    await expect(provider.reopenPullRequest(ref)).rejects.toMatchObject({
      code: "SCM_INVALID_STATE",
    });
  expect(calls).toHaveLength(1);
});

test.each(["identity", "state", "malformed"])(
  "GitHub reports a possibly-applied reopen when the response has invalid %s",
  async (problem) => {
    const { provider, calls } = githubProvider((_, request) =>
      Response.json(
        githubPr(
          request.method === "PATCH"
            ? problem === "identity"
              ? { number: 99 }
              : problem === "state"
                ? { state: "closed" }
                : { title: null }
            : { state: "closed" },
        ),
      ),
    );

    await expect(provider.reopenPullRequest(ref)).rejects.toMatchObject({
      code: "SCM_PARTIAL_FAILURE",
    });
    expect(calls).toHaveLength(2);
  },
);

test("GitHub reopen rejects a mismatched preflight response before writing and normalizes update failures", async () => {
  const mismatch = githubProvider(() => Response.json(githubPr({ number: 99, state: "closed" })));

  await expect(mismatch.provider.reopenPullRequest(ref)).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
  expect(mismatch.calls).toHaveLength(1);

  const denied = githubProvider((_, request) =>
    request.method === "PATCH"
      ? Response.json({}, { status: 403 })
      : Response.json(githubPr({ state: "closed" })),
  );

  await expect(denied.provider.reopenPullRequest(ref)).rejects.toMatchObject({
    code: "SCM_ACCESS_DENIED",
  });
  expect(denied.calls).toHaveLength(2);
});
