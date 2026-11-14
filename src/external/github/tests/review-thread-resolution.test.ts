import { expect, test } from "bun:test";
import { githubProvider } from "./support/github";

const ref = { provider: "github" as const, owner: "acme", repository: "app", number: 12 };

function ownerResponse(isResolved = false) {
  return {
    data: {
      node: {
        id: "thread-node-1",
        isResolved,
        pullRequest: { number: 12, repository: { name: "app", owner: { login: "acme" } } },
      },
    },
  };
}

test("resolves and unresolves only a thread owned by the exact PR", async () => {
  let isResolved = false;
  const { provider, calls } = githubProvider((url, request) => {
    if (url.pathname !== "/graphql") return Response.json({});
    const body = JSON.parse(String(request.body)) as { query: string };
    if (body.query.includes("mutation")) {
      isResolved = !body.query.includes("unresolveReviewThread");
      const name = isResolved ? "resolveReviewThread" : "unresolveReviewThread";
      return Response.json({
        data: { [name]: { thread: { id: "thread-node-1", isResolved } } },
      });
    }
    return Response.json(ownerResponse(isResolved));
  });

  await expect(provider.setReviewThreadResolution(ref, "thread-node-1", true)).resolves.toEqual({
    threadId: "thread-node-1",
    isResolved: true,
    changed: true,
  });
  await expect(provider.setReviewThreadResolution(ref, "thread-node-1", false)).resolves.toEqual({
    threadId: "thread-node-1",
    isResolved: false,
    changed: true,
  });
  expect(calls).toHaveLength(4);
});

test("rejects a thread from another PR without attempting a mutation", async () => {
  let calls = 0;
  const { provider } = githubProvider(() => {
    calls++;
    return Response.json({
      data: {
        node: {
          id: "thread-node-1",
          isResolved: false,
          pullRequest: { number: 13, repository: { name: "app", owner: { login: "acme" } } },
        },
      },
    });
  });

  await expect(
    provider.setReviewThreadResolution(ref, "thread-node-1", true),
  ).rejects.toMatchObject({ code: "SCM_INVALID_REFERENCE" });
  expect(calls).toBe(1);
});

test("returns unchanged resolution state without a mutation", async () => {
  let calls = 0;
  const { provider } = githubProvider(() => {
    calls++;
    return Response.json(ownerResponse(true));
  });

  await expect(provider.setReviewThreadResolution(ref, "thread-node-1", true)).resolves.toEqual({
    threadId: "thread-node-1",
    isResolved: true,
    changed: false,
  });
  expect(calls).toBe(1);
});

test("reports mutation transport failures as possibly applied", async () => {
  const { provider } = githubProvider((url, request) => {
    const body = JSON.parse(String(request.body)) as { query: string };
    if (body.query.includes("resolveReviewThread")) return Response.error();
    return Response.json(ownerResponse());
  });

  await expect(
    provider.setReviewThreadResolution(ref, "thread-node-1", true),
  ).rejects.toMatchObject({ code: "SCM_PARTIAL_FAILURE" });
});
