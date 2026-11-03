const pr = {
  number: 12,
  html_url: "https://github.com/acme/app/pull/12",
  title: "Improve login",
  body: "Details",
  state: "open",
  merged: false,
  draft: true,
  head: { ref: "topic", sha: "abc" },
  base: { ref: "main" },
};
let checkReads = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.hostname !== "api.github.com") throw new Error("Unexpected request host");
  const response = respond(url);
  Object.defineProperty(response, "url", { value: url.href });

  return response;
}) as typeof fetch;

await import("../../../../../apps/cli/src/main");

function respond(url: URL): Response {
  if (url.pathname.endsWith("/pulls/404"))
    return Response.json({ message: "secret-token" }, { status: 404 });
  if (url.pathname.endsWith("/pulls/12")) return Response.json(pr);
  if (url.pathname.endsWith("/pulls")) return Response.json([pr]);
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
  if (url.pathname.endsWith("/reviews"))
    return Response.json([{ id: 1, user: { id: 7, login: "alice" }, state: "APPROVED" }]);
  if (url.pathname.endsWith("/requested_reviewers")) return Response.json({ users: [], teams: [] });

  throw new Error("Unexpected SDK request");
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
