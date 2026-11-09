const pr = {
  number: 12,
  node_id: "PR_node_12",
  html_url: "https://github.com/acme/app/pull/12",
  title: "Improve login",
  body: "Details",
  state: process.env.PR_STATE === "closed" || process.env.PR_STATE === "merged" ? "closed" : "open",
  merged: process.env.PR_STATE === "merged",
  merged_at: process.env.PR_STATE === "merged" ? "2026-11-10T00:00:00Z" : null,
  user: { id: 7, login: "alice" },
  draft: true,
  head: { ref: "topic", sha: "abc", repo: { owner: { login: "acme" }, name: "app" } },
  base: { ref: "main", repo: { owner: { login: "acme" }, name: "app" } },
};
let checkReads = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.hostname !== "api.github.com") throw new Error("Unexpected request host");
  if (process.env.PR_FORBID_REQUESTS) throw new Error("SDK requests are forbidden for this test");
  if (init?.method === "POST" && url.pathname.endsWith("/pulls")) {
    const body = JSON.parse(String(init.body));
    return Response.json({
      ...pr,
      title: body.title,
      body: body.body,
      draft: body.draft,
      head: { ...pr.head, ref: body.head },
      base: { ...pr.base, ref: body.base },
    });
  }
  if (init?.method === "PATCH") applyPatch(init);
  if (url.pathname === "/graphql") {
    const body = JSON.parse(String(init?.body));
    pr.draft = body.query.includes("convertPullRequestToDraft");
    const operation = pr.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";

    return Response.json({
      data: { [operation]: { pullRequest: { id: pr.node_id, isDraft: pr.draft } } },
    });
  }
  const response = respond(url);
  Object.defineProperty(response, "url", { value: url.href });

  return response;
}) as typeof fetch;

await import("../../../../../apps/cli/src/main");

function applyPatch(request: RequestInit) {
  const patch = JSON.parse(String(request.body));
  if (patch.title !== undefined) pr.title = patch.title;
  if (patch.body !== undefined) pr.body = patch.body;
  if (patch.base !== undefined) pr.base.ref = patch.base;
  if (patch.state !== undefined) pr.state = patch.state;
}

function respond(url: URL): Response {
  if (/\/(pulls|issues)\/404(?:\/|$)/.test(url.pathname))
    return Response.json({ message: "secret-token" }, { status: 404 });
  if (url.pathname.endsWith("/pulls/12")) return Response.json(pr);
  if (url.pathname.endsWith("/pulls")) return listResponse();
  if (url.pathname.endsWith("/issues/12/comments"))
    return Response.json([
      { id: 1, body: "Looks good", user: { id: 7, login: "alice" }, created_at: "2026-01-01" },
    ]);
  if (url.pathname.endsWith("/pulls/12/comments")) return Response.json([]);
  if (url.pathname.endsWith("/protection"))
    return Response.json({ required_status_checks: { contexts: ["build"] } });
  if (url.pathname.includes("/rules/branches/")) return Response.json([]);
  if (url.pathname.endsWith("/check-runs")) return checkResponse();
  if (url.pathname.endsWith("/statuses")) return Response.json([]);
  if (url.pathname.endsWith("/reviews")) return Response.json(reviewResponse());
  if (url.pathname.endsWith("/requested_reviewers"))
    return Response.json(
      process.env.PR_REVIEW_MODE === "mixed"
        ? { users: [{ id: 8, login: "bob" }], teams: [{ id: 1, slug: "security" }] }
        : { users: [], teams: [] },
    );

  throw new Error("Unexpected SDK request");
}

function listResponse() {
  if (process.env.PR_LIST_MODE === "empty") return Response.json([]);
  if (process.env.PR_LIST_MODE === "denied")
    return Response.json({ message: "secret-token" }, { status: 403 });

  return Response.json([pr]);
}

function reviewResponse() {
  if (process.env.PR_REVIEW_MODE === "empty") return [];
  const approved = { id: 1, user: { id: 7, login: "alice" }, state: "APPROVED" };
  if (process.env.PR_REVIEW_MODE !== "mixed") return [approved];

  return [
    approved,
    { id: 2, user: { id: 8, login: "bob" }, state: "APPROVED" },
    { id: 3, user: { id: 9, login: "charlie" }, state: "DISMISSED" },
    { id: 4, user: { id: 10, login: "dee" }, state: "COMMENTED" },
  ];
}

function checkResponse(): Response {
  checkReads++;
  if (process.env.PR_SIGNAL)
    setTimeout(() => process.kill(process.pid, process.env.PR_SIGNAL as NodeJS.Signals), 1);
  const mode = process.env.PR_CHECK_MODE ?? "passed";
  if (mode === "empty") return Response.json({ total_count: 0, check_runs: [] });
  const pending = mode === "pending" || (mode === "transition" && checkReads === 1);
  const conclusions: Record<string, string> = {
    failed: "failure",
    cancelled: "cancelled",
    unknown: "new-state",
  };

  return Response.json({
    total_count: 1,
    check_runs: [
      {
        id: 1,
        name: "build",
        status: pending ? "queued" : "completed",
        conclusion: pending ? null : (conclusions[mode] ?? "success"),
      },
    ],
  });
}
