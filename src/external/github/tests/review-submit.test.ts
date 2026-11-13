import { expect, test } from "bun:test";
import { githubPr, githubProvider } from "./support/github";

const ref = { provider: "github" as const, owner: "acme", repository: "app", number: 12 };
const head = "a".repeat(40);

test.each([
  ["approve", "APPROVE", "approved"],
  ["request-changes", "REQUEST_CHANGES", "changes-requested"],
  ["comment", "COMMENT", "commented"],
] as const)("submits %s review against the inspected head", async (event, expectedEvent, state) => {
  const calls: { path: string; method: string; body?: any }[] = [];
  const { provider } = githubProvider((url, request) => {
    calls.push({
      path: url.pathname,
      method: request.method ?? "GET",
      ...(request.body ? { body: JSON.parse(String(request.body)) } : {}),
    });
    if (request.method === "POST")
      return Response.json({
        id: 91,
        state:
          expectedEvent === "REQUEST_CHANGES"
            ? "CHANGES_REQUESTED"
            : expectedEvent === "COMMENT"
              ? "COMMENTED"
              : "APPROVED",
        user: { id: 7, login: "alice" },
      });
    return Response.json(githubPr({ head: { ref: "topic", sha: head } }));
  });

  await expect(
    provider.submitReview(ref, {
      event,
      body: event === "approve" ? undefined : "Please update",
      expectedHead: head,
    }),
  ).resolves.toEqual({ reviewer: { id: "user:7", name: "alice" }, state });
  expect(calls[1]?.body).toEqual({
    commit_id: head,
    event: expectedEvent,
    ...(event === "approve" ? {} : { body: "Please update" }),
  });
});

test("refuses stale review heads before submitting", async () => {
  const { provider, calls } = githubProvider(() =>
    Response.json(githubPr({ head: { ref: "topic", sha: head } })),
  );

  await expect(
    provider.submitReview(ref, { event: "approve", expectedHead: "b".repeat(40) }),
  ).rejects.toMatchObject({ code: "SCM_STALE_HEAD" });
  expect(calls).toHaveLength(1);
});
