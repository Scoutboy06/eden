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
  base: { ref: "main", sha: "base123", repo: { owner: { login: "acme" }, name: "app" } },
};
let checkReads = 0;
let reviewRequests: {
  users: { id: number; login: string }[];
  teams: { id: number; slug: string }[];
} = { users: [], teams: [] };
let threadResolved = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.hostname !== "api.github.com") throw new Error("Unexpected request host");
  if (process.env.PR_FORBID_REQUESTS) throw new Error("SDK requests are forbidden for this test");
  if (init?.method === "POST") {
    const response = postResponse(url, init);
    if (response) return response;
  }
  if (init?.method !== "GET" && url.pathname.endsWith("/requested_reviewers")) {
    if (process.env.PR_REVIEW_REQUEST_FAIL)
      return Response.json(
        { message: "denied" },
        { status: Number(process.env.PR_REVIEW_REQUEST_FAIL) },
      );
    const body = JSON.parse(String(init?.body));
    reviewRequests = {
      users: body.reviewers.map((login: string, id: number) => ({ id: id + 20, login })),
      teams: body.team_reviewers.map((slug: string, id: number) => ({ id: id + 30, slug })),
    };
    return Response.json({
      ...pr,
      requested_reviewers: reviewRequests.users,
      teams: reviewRequests.teams,
    });
  }
  const mergeResponse = respondMergeMutation(url, init);
  if (mergeResponse) return mergeResponse;
  if (init?.method === "PATCH") applyPatch(init);
  const response = respond(url);
  Object.defineProperty(response, "url", { value: url.href });

  return response;
}) as typeof fetch;

function respondMergeMutation(url: URL, init?: RequestInit): Response | undefined {
  if (init?.method === "PUT" && url.pathname.endsWith("/pulls/12/merge")) {
    pr.state = "closed";
    pr.merged = true;
    return Response.json({ merged: true, sha: pr.head.sha, message: "Merged" });
  }
  if (init?.method === "DELETE" && url.pathname.includes("/git/refs/heads%2Ftopic"))
    return new Response(null, { status: 204 });
}

await import("../../../../../apps/cli/src/main");

function postResponse(url: URL, init: RequestInit): Response | undefined {
  if (url.pathname.endsWith("/pulls/12/reviews"))
    return Response.json({
      id: 91,
      state: JSON.parse(String(init.body)).event === "APPROVE" ? "APPROVED" : "COMMENTED",
      user: { id: 7, login: "alice" },
    });
  if (url.pathname.endsWith("/issues/12/comments")) {
    if (process.env.PR_COMMENT_FAIL)
      return Response.json({ message: "secret-token" }, { status: 403 });
    return Response.json(commentResponse(init));
  }
  if (url.pathname.endsWith("/pulls/12/comments/56/replies"))
    return Response.json(commentResponse(init, true));
  if (url.pathname.endsWith("/issues/12/labels")) return Response.json([{ name: "feature" }]);
  if (url.pathname.endsWith("/pulls")) {
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
  if (url.pathname === "/graphql") return respondGraphql(init);
}

function respondGraphql(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body));
  if (body.query.includes("reviewThreads")) return reviewThreadsResponse();
  if (body.query.includes("PullRequestReviewThread")) return threadOwnershipResponse();
  if (body.query.includes("resolveReviewThread") || body.query.includes("unresolveReviewThread"))
    return threadMutationResponse(body.query);
  pr.draft = body.query.includes("convertPullRequestToDraft");
  const operation = pr.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";

  return Response.json({
    data: { [operation]: { pullRequest: { id: pr.node_id, isDraft: pr.draft } } },
  });
}

function reviewThreadsResponse() {
  return Response.json({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "thread-node-1",
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      databaseId: 56,
                      body: "Please update",
                      createdAt: "2026-11-10T00:00:00Z",
                      path: "src/auth.ts",
                      line: 4,
                      user: { databaseId: 7, login: "alice" },
                      replyTo: null,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  });
}

function threadOwnershipResponse() {
  return Response.json({
    data: {
      node: {
        id: "thread-node-1",
        isResolved: threadResolved,
        pullRequest: { number: 12, repository: { name: "app", owner: { login: "acme" } } },
      },
    },
  });
}

function threadMutationResponse(query: string) {
  threadResolved = !query.includes("unresolveReviewThread");
  const operation = threadResolved ? "resolveReviewThread" : "unresolveReviewThread";

  return Response.json({
    data: { [operation]: { thread: { id: "thread-node-1", isResolved: threadResolved } } },
  });
}
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
  if (url.pathname.endsWith("/pulls/12/files"))
    return Response.json([
      {
        filename: "src/auth.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1,2 +1,3 @@\n old\n-old\n+new\n+line",
      },
      { filename: "README.md", status: "modified", additions: 1, deletions: 0 },
      {
        filename: "src/new file.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+new",
      },
      {
        filename: "src/old\tfile.ts",
        status: "removed",
        additions: 0,
        deletions: 1,
        patch: "@@ -1 +0,0 @@\n-old",
      },
      {
        filename: "src/rename new.ts",
        previous_filename: "src/rename old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
      {
        filename: 'src/quoted"file.ts',
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ]);
  if (url.pathname.endsWith("/pulls/comments/56"))
    return Response.json({
      id: 56,
      pull_request_url: "https://api.github.com/repos/acme/app/pulls/12",
    });
  if (url.pathname.endsWith("/pulls")) return listResponse();
  if (url.pathname.endsWith("/issues/12/comments"))
    return Response.json([
      { id: 1, body: "Looks good", user: { id: 7, login: "alice" }, created_at: "2026-01-01" },
    ]);
  if (url.pathname.endsWith("/pulls/12/comments")) return Response.json([]);
  if (url.pathname.includes("/git/ref/")) return Response.json({ object: { sha: pr.head.sha } });
  if (url.pathname.endsWith("/protection"))
    return Response.json({ required_status_checks: { contexts: ["build"] } });
  if (url.pathname.includes("/rules/branches/")) return Response.json([]);
  if (url.pathname.endsWith("/check-runs")) return checkResponse();
  if (url.pathname.endsWith("/statuses")) return Response.json([]);
  if (url.pathname.endsWith("/reviews")) return Response.json(reviewResponse());
  if (url.pathname.endsWith("/requested_reviewers")) return requestedReviewerResponse();

  throw new Error("Unexpected SDK request");
}

function requestedReviewerResponse(): Response {
  if (process.env.PR_REVIEW_MODE === "confirm-missing")
    return Response.json({ users: [], teams: [] });
  if (reviewRequests.users.length || reviewRequests.teams.length)
    return Response.json(reviewRequests);
  if (process.env.PR_REVIEW_MODE === "mixed")
    return Response.json({
      users: [{ id: 8, login: "bob" }],
      teams: [{ id: 1, slug: "security" }],
    });

  return Response.json({ users: [], teams: [] });
}

function commentResponse(request: RequestInit, reply = false) {
  return {
    id: 34,
    body: JSON.parse(String(request.body)).body,
    user: { id: 7, login: "alice" },
    created_at: "2026-11-10T00:00:00Z",
    html_url: `https://github.com/acme/app/pull/12#${reply ? "discussion_r" : "issuecomment-"}34`,
    ...(reply
      ? { pull_request_url: "https://api.github.com/repos/acme/app/pulls/12", in_reply_to_id: 56 }
      : { issue_url: "https://api.github.com/repos/acme/app/issues/12" }),
  };
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
