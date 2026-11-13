import { expect, test } from "bun:test";
import { githubPr, githubProvider } from "./support/github";

const ref = { provider: "github" as const, owner: "acme", repository: "app", number: 12 };
const head = "a".repeat(40);

test.each(["merge", "squash", "rebase"] as const)(
  "merges with %s and an atomic expected head",
  async (method) => {
    const calls: { path: string; method: string; body?: any }[] = [];
    let merged = false;
    const { provider } = githubProvider((url, request) => {
      calls.push({
        path: url.pathname,
        method: request.method ?? "GET",
        ...(request.body ? { body: JSON.parse(String(request.body)) } : {}),
      });
      if (request.method === "PUT") {
        merged = true;
        return Response.json({ merged: true, sha: head, message: "Merged" });
      }
      return Response.json(
        githubPr({
          state: merged ? "closed" : "open",
          merged,
          head: { ref: "topic", sha: head, repo: { owner: { login: "acme" }, name: "app" } },
        }),
      );
    });

    const result = await provider.mergePullRequest(ref, { method, expectedHead: head });

    expect(result).toMatchObject({ pr: { state: "merged" }, deletedBranch: false });
    expect(calls[1]?.body).toEqual({ merge_method: method, sha: head });
  },
);

test("deletes only the verified source branch after a confirmed merge", async () => {
  const calls: string[] = [];
  let merged = false;
  const { provider } = githubProvider((url, request) => {
    calls.push(`${request.method}:${url.pathname}`);
    if (url.pathname.endsWith("/merge")) {
      merged = true;
      return Response.json({ merged: true, sha: head, message: "Merged" });
    }
    if (url.pathname.endsWith("/git/refs/heads%2Ftopic") && request.method === "DELETE")
      return new Response(null, { status: 204 });
    if (url.pathname.includes("/git/ref/")) return Response.json({ object: { sha: head } });
    return Response.json(
      githubPr({
        state: merged ? "closed" : "open",
        merged,
        head: { ref: "topic", sha: head, repo: { owner: { login: "acme" }, name: "app" } },
      }),
    );
  });

  const result = await provider.mergePullRequest(ref, { method: "squash", deleteBranch: true });

  expect(result.deletedBranch).toBe(true);
  expect(calls.at(-1)).toBe("DELETE:/repos/acme/app/git/refs/heads%2Ftopic");
});

test("stale expected head and unsafe delete targets are rejected before mutation", async () => {
  let reads = 0;
  const { provider, calls } = githubProvider(() =>
    Response.json(
      githubPr({
        head: {
          ref: ++reads === 1 ? "topic" : "../bad",
          sha: head,
          repo: { owner: { login: "acme" }, name: "app" },
        },
      }),
    ),
  );

  await expect(
    provider.mergePullRequest(ref, {
      method: "merge",
      expectedHead: "b".repeat(40),
    }),
  ).rejects.toMatchObject({ code: "SCM_STALE_HEAD" });
  await expect(
    provider.mergePullRequest(ref, {
      method: "merge",
      deleteBranch: true,
    }),
  ).rejects.toMatchObject({ code: "SCM_INVALID_REFERENCE" });
  expect(calls).toHaveLength(2);
});

test("reports an atomic merge rejection without confusing conflict and stale-head cases", async () => {
  const { provider } = githubProvider((url, request) => {
    if (request.method === "PUT")
      return Response.json({ message: "Head branch was modified" }, { status: 409 });

    return Response.json(
      githubPr({
        head: { ref: "topic", sha: head, repo: { owner: { login: "acme" }, name: "app" } },
      }),
    );
  });

  await expect(
    provider.mergePullRequest(ref, {
      method: "merge",
      expectedHead: head,
    }),
  ).rejects.toMatchObject({ code: "SCM_MERGE_REJECTED" });
});

test.each([
  [405, "SCM_INVALID_STATE"],
  [403, "SCM_ACCESS_DENIED"],
])(
  "reports definite merge rejection %s without claiming a possible merge",
  async (status, code) => {
    const { provider } = githubProvider((url, request) => {
      if (request.method === "PUT") return Response.json({ message: "rejected" }, { status });

      return Response.json(
        githubPr({
          head: { ref: "topic", sha: head, repo: { owner: { login: "acme" }, name: "app" } },
        }),
      );
    });

    await expect(provider.mergePullRequest(ref, { method: "merge" })).rejects.toMatchObject({
      code,
    });
  },
);

test("reports a confirmed merge when optional source deletion fails", async () => {
  let merged = false;
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/merge")) {
      merged = true;
      return Response.json({ merged: true, sha: head, message: "Merged" });
    }
    if (url.pathname.includes("/git/ref/"))
      return Response.json({ object: { sha: "b".repeat(40) } });

    return Response.json(
      githubPr({
        state: merged ? "closed" : "open",
        merged,
        head: { ref: "topic", sha: head, repo: { owner: { login: "acme" }, name: "app" } },
      }),
    );
  });

  await expect(
    provider.mergePullRequest(ref, {
      method: "merge",
      deleteBranch: true,
    }),
  ).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
    message: expect.stringContaining("The merge succeeded"),
  });
});

test("never deletes a same-named branch from the base repository for a fork PR", async () => {
  const { provider, calls } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12"))
      return Response.json(
        githubPr({
          head: { ref: "topic", sha: head, repo: { owner: { login: "forker" }, name: "app" } },
        }),
      );
    throw new Error("Merge should not be attempted");
  });

  await expect(
    provider.mergePullRequest(ref, {
      method: "merge",
      deleteBranch: true,
    }),
  ).rejects.toMatchObject({ code: "SCM_UNSUPPORTED_OPERATION" });
  expect(calls).toHaveLength(1);
});
