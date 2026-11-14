import { expect, test } from "bun:test";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import { githubPr, githubProvider } from "./support/github";

const ref: PullRequestRef = { provider: "github", owner: "acme", repository: "app", number: 12 };

test("checks combine CI runs and latest legacy commit statuses", async () => {
  const { provider, calls } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({
        total_count: 3,
        check_runs: [
          {
            id: 1,
            name: "build",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/build",
          },
          { id: 2, name: "test", status: "in_progress", conclusion: null },
          { id: 3, name: "optional", status: "completed", conclusion: "neutral" },
        ],
      });

    return Response.json([
      { id: 9, context: "external", state: "success" },
      { id: 8, context: "external", state: "failure" },
    ]);
  });

  const checks = await provider.getChecks(ref);
  const requestSummaries = calls.map((url) => ({
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
  }));

  expect(checks).toEqual([
    { id: "check:1", name: "build", state: "passed", url: "https://github.com/build" },
    { id: "check:2", name: "test", state: "running" },
    { id: "check:3", name: "optional", state: "skipped" },
    { id: "status:9", name: "external", state: "passed" },
  ]);
  expect(calls).toHaveLength(3);
  expect(requestSummaries).toEqual(
    expect.arrayContaining([
      { path: "/repos/acme/app/pulls/12", query: {} },
      {
        path: "/repos/acme/app/commits/abc/check-runs",
        query: { per_page: "100", filter: "latest" },
      },
      { path: "/repos/acme/app/commits/abc/statuses", query: { per_page: "100" } },
    ]),
  );
});

test("required checks combine classic protection and rulesets, retaining missing requirements", async () => {
  const { provider, calls } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/protection"))
      return Response.json({
        required_status_checks: {
          contexts: ["build", "legacy"],
          checks: [{ context: "build", app_id: 7 }],
        },
      });
    if (url.pathname.includes("/rules/branches/"))
      return Response.json([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "build", integration_id: 7 },
              { context: "missing" },
            ],
          },
        },
      ]);
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({
        total_count: 3,
        check_runs: [
          { id: 1, name: "build", app: { id: 8 }, status: "completed", conclusion: "success" },
          { id: 2, name: "build", app: { id: 7 }, status: "in_progress" },
          { id: 3, name: "optional", status: "completed", conclusion: "failure" },
        ],
      });

    return Response.json([{ id: 4, context: "legacy", state: "success" }]);
  });

  const requiredChecks = await provider.getChecks(ref, { requiredOnly: true });

  expect(requiredChecks).toEqual([
    { id: "check:2", name: "build", state: "running" },
    { id: "status:4", name: "legacy", state: "passed" },
    { id: "required:missing:any", name: "missing", state: "pending" },
  ]);
  expect(calls.some((url) => url.pathname.endsWith("/branches/main/protection"))).toBe(true);
});

test("unprotected branches have no required checks", async () => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/protection")) return Response.json({}, { status: 404 });
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: 0, check_runs: [] });

    return Response.json([]);
  });

  expect(await provider.getChecks(ref, { requiredOnly: true })).toEqual([]);
});

test("GitHub checks forward cancellation to every SDK request", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const controller = new AbortController();
  const { provider } = githubProvider((url, request) => {
    signals.push(request.signal);
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/protection")) return Response.json({});
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: 0, check_runs: [] });

    return Response.json([]);
  });

  await provider.getChecks(ref, { requiredOnly: true, signal: controller.signal });

  expect(signals).toHaveLength(5);
  const signalStates = signals.map((signal) => signal?.aborted ?? "missing");

  expect(signalStates).toEqual([false, false, false, false, false]);

  controller.abort();

  expect(signals.every((signal) => signal?.aborted)).toBe(true);
});

test.each([403, 500])("required-check discovery fails explicitly on HTTP %i", async (status) => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/protection")) return Response.json({}, { status });
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: 0, check_runs: [] });

    return Response.json([]);
  });

  await expect(provider.getChecks(ref, { requiredOnly: true })).rejects.toMatchObject({
    code: status === 403 ? "SCM_ACCESS_DENIED" : "SCM_REQUEST_FAILED",
  });
});

test("required workflow rules report the unsupported projection explicitly", async () => {
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/protection")) return Response.json({});
    if (url.pathname.includes("/rules/branches/")) return Response.json([{ type: "workflows" }]);
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: 0, check_runs: [] });

    return Response.json([]);
  });

  await expect(provider.getChecks(ref, { requiredOnly: true })).rejects.toMatchObject({
    code: "SCM_UNSUPPORTED_OPERATION",
  });
});
