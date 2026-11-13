import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCli } from "./support/cli";

const fixture = fileURLToPath(new URL("./fixtures/pr.ts", import.meta.url));

test("PR request-review declares hyphenated command, renders results and structures failures", async () => {
  const help = await runCli("pr", "request-review", "--help");
  const completion = await runCli("completion", "bash");
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("--reviewer");
  expect(help.stdout).toContain("--team");
  expect(completion.stdout).toContain("request-review");
  const args = [
    "pr",
    "request-review",
    "https://github.com/acme/app/pull/12",
    "--reviewer",
    "bob,bob",
    "--team",
    "security",
  ];
  const human = await runPr(...args);
  const json = await runPr(...args, "--json");
  const dry = await runPrWithEnv({ PR_FORBID_REQUESTS: "1" }, ...args, "--dry-run", "--json");
  const invalid = await runPr(
    "pr",
    "request-review",
    "12",
    "--repo",
    "https://github.com/acme/app",
    "--team",
    "org/security",
    "--json",
  );
  const denied = await runPrWithEnv({ PR_REVIEW_REQUEST_FAIL: "403" }, ...args, "--json");
  const uncertain = await runPrWithEnv({ PR_REVIEW_REQUEST_FAIL: "500" }, ...args, "--json");

  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("Requested: bob, security");
  expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, requested: ["bob", "security"] });
  expect(JSON.parse(dry.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [
      { type: "github-pr-request-review", input: { reviewers: ["bob"], teams: ["security"] } },
    ],
  });
  expect(invalid.exitCode).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ error: { code: "SCM_INVALID_OPTIONS" } });
  expect(JSON.parse(denied.stdout)).toMatchObject({ error: { code: "SCM_ACCESS_DENIED" } });
  expect(JSON.parse(uncertain.stdout)).toMatchObject({ error: { code: "SCM_PARTIAL_FAILURE" } });
});

test("PR comment declares inputs and renders discussion and reply identities", async () => {
  const help = await runCli("pr", "comment", "--help");
  const completion = await runCli("completion", "bash");
  for (const flag of ["--body", "--body-file", "--reply-to"]) {
    expect(help.stdout).toContain(flag);
    expect(completion.stdout).toContain(flag);
  }
  const args = ["pr", "comment", "https://github.com/acme/app/pull/12", "--body", "Hello"];
  const human = await runPr(...args);
  const json = await runPr(...args, "--reply-to", "review:56", "--json");

  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("issue:34\nhttps://github.com/acme/app/pull/12#issuecomment-34");
  expect(json.exitCode).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    comment: { id: "review:34", body: "Hello", threadId: "56" },
  });
});

test("PR comment dry-run sends no HTTP and input/provider failures are structured", async () => {
  const args = ["pr", "comment", "https://github.com/acme/app/pull/12", "--body", "Hello"];
  const dry = await runPrWithEnv(
    { PR_FORBID_REQUESTS: "1" },
    ...args,
    "--reply-to",
    "review:56",
    "--dry-run",
    "--json",
  );
  const invalid = await runPr(...args, "--body-file", "missing");
  const unsupported = await runPr(...args, "--reply-to", "issue:56", "--json");
  const denied = await runPrWithEnv({ PR_COMMENT_FAIL: "1" }, ...args, "--json");

  expect(dry.exitCode).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [{ type: "github-pr-comment", input: { body: "Hello", replyTo: "review:56" } }],
  });
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toContain("mutually exclusive");
  expect(unsupported.exitCode).toBe(1);
  expect(JSON.parse(unsupported.stdout)).toMatchObject({
    error: { code: "SCM_UNSUPPORTED_OPERATION" },
  });
  expect(denied.exitCode).toBe(1);
  expect(JSON.parse(denied.stdout)).toMatchObject({ error: { code: "SCM_ACCESS_DENIED" } });
  expect(denied.stdout).not.toContain("secret-token");
});

test("PR comments declare filters and render review threads in human and JSON output", async () => {
  const help = await runCli("pr", "comments", "--help");
  const completion = await runCli("completion", "bash");
  for (const flag of ["--unresolved", "--since", "--limit"]) {
    expect(help.stdout).toContain(flag);
    expect(completion.stdout).toContain(flag);
  }
  const args = ["pr", "comments", "https://github.com/acme/app/pull/12", "--unresolved"];
  const human = await runPr(...args);
  const json = await runPr(...args, "--json");

  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("review:56 (unresolved)");
  expect(human.stdout).toContain("Please update");
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    threads: [[{ id: "review:56", threadId: "thread-node-1", replyTo: "review:56" }]],
    hasMore: false,
  });
});

test("PR resolve and unresolve declare commands and render state with dry-run SDK isolation", async () => {
  const resolveHelp = await runCli("pr", "resolve", "--help");
  const unresolveHelp = await runCli("pr", "unresolve", "--help");
  const completion = await runCli("completion", "bash");
  expect(resolveHelp.stdout).toContain("thread");
  expect(unresolveHelp.stdout).toContain("thread");
  expect(completion.stdout).toContain("unresolve");
  const target = ["pr", "resolve", "https://github.com/acme/app/pull/12", "thread-node-1"];
  const human = await runPr(...target);
  const json = await runPr("pr", "unresolve", ...target.slice(2), "--json");
  const dry = await runPrWithEnv({ PR_FORBID_REQUESTS: "1" }, ...target, "--dry-run", "--json");

  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("thread-node-1\nresolved");
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    thread: { threadId: "thread-node-1", isResolved: false },
  });
  expect(JSON.parse(dry.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [
      {
        type: "github-pr-review-thread-resolution",
        input: { threadId: "thread-node-1", isResolved: true },
      },
    ],
  });
});

test("PR review and merge require explicit valid choices and render verified mutations", async () => {
  const reviewHelp = await runCli("pr", "review", "--help");
  const mergeHelp = await runCli("pr", "merge", "--help");
  const reviewArgs = ["pr", "review", "https://github.com/acme/app/pull/12", "--event", "approve"];
  const review = await runPr(...reviewArgs, "--json");
  const reviewDryRun = await runPrWithEnv(
    { PR_FORBID_REQUESTS: "1" },
    ...reviewArgs,
    "--expected-head",
    "a".repeat(40),
    "--dry-run",
    "--json",
  );
  const mergeArgs = ["pr", "merge", "https://github.com/acme/app/pull/12", "--method", "squash"];
  const merge = await runPr(...mergeArgs, "--json");
  const invalid = await runPr(
    "pr",
    "review",
    "https://github.com/acme/app/pull/12",
    "--event",
    "request-changes",
    "--json",
  );

  expect(reviewHelp.stdout).toContain("--expected-head");
  expect(mergeHelp.stdout).toContain("--delete-branch");
  expect(review.exitCode).toBe(0);
  expect(JSON.parse(review.stdout)).toMatchObject({ ok: true, review: { state: "approved" } });
  expect(reviewDryRun.exitCode).toBe(0);
  expect(JSON.parse(reviewDryRun.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [{ type: "github-pr-review", input: { expectedHead: "a".repeat(40) } }],
  });
  expect(merge.exitCode).toBe(0);
  expect(JSON.parse(merge.stdout)).toMatchObject({ ok: true, pr: { state: "merged" } });
  expect(invalid.exitCode).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({
    error: { code: "SCM_INVALID_OPTIONS" },
  });
});

test("PR close declares comment, renders success and records no-HTTP dry-run", async () => {
  const help = await runCli("pr", "close", "--help");
  const completion = await runCli("completion", "bash");
  expect(help.stdout).toContain("--comment");
  expect(completion.stdout).toContain("--comment");
  const args = [
    "pr",
    "close",
    "https://github.com/acme/app/pull/12",
    "--comment",
    "Closing this PR",
  ];
  const human = await runPr(...args);
  const json = await runPr(...args, "--json");
  const dry = await runPrWithEnv({ PR_FORBID_REQUESTS: "1" }, ...args, "--dry-run", "--json");

  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("closed\nhttps://github.com/acme/app/pull/12");
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    pr: { state: "closed", ref: { number: 12 } },
  });
  expect(dry.exitCode).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [{ type: "github-pr-close", input: { comment: "Closing this PR" } }],
  });
});

test("PR close reports metadata partial failure and remains idempotent for closed PRs", async () => {
  const args = [
    "pr",
    "close",
    "https://github.com/acme/app/pull/12",
    "--comment",
    "Closing",
    "--json",
  ];
  const partial = await runPrWithEnv({ PR_COMMENT_FAIL: "1" }, ...args);
  const closed = await runPrWithEnv({ PR_COMMENT_FAIL: "1", PR_STATE: "closed" }, ...args);
  const merged = await runPrWithEnv({ PR_STATE: "merged" }, ...args);

  expect(partial.exitCode).toBe(1);
  expect(JSON.parse(partial.stdout)).toMatchObject({
    error: {
      code: "SCM_PARTIAL_FAILURE",
      message: expect.stringContaining("PR closed: https://github.com/acme/app/pull/12"),
    },
  });
  expect(partial.stdout).not.toContain("secret-token");
  expect(closed.exitCode).toBe(0);
  expect(JSON.parse(closed.stdout)).toMatchObject({ ok: true, pr: { state: "closed" } });
  expect(merged.exitCode).toBe(1);
  expect(JSON.parse(merged.stdout)).toMatchObject({ error: { code: "SCM_INVALID_STATE" } });
});

test("PR list declares filters and renders human and JSON results", async () => {
  const help = await runCli("pr", "list", "--help");
  const completion = await runCli("completion", "bash");
  for (const flag of ["--repo", "--remote", "--state", "--author", "--draft", "--limit"]) {
    expect(help.stdout).toContain(flag);
    expect(completion.stdout).toContain(flag);
  }
  expect(completion.stdout).toContain("merged");
  const args = [
    "pr",
    "list",
    "--repo",
    "https://github.com/acme/app",
    "--state",
    "all",
    "--author",
    "alice",
    "--draft",
    "--limit",
    "1",
  ];
  const human = await runPr(...args);
  const json = await runPr(...args, "--json", "--dry-run");

  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("#12\topen (draft)\tImprove login");
  expect(human.stdout).toContain("https://github.com/acme/app/pull/12");
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    prs: [{ ref: { number: 12 }, author: { name: "alice" } }],
  });
});

test("PR list renders empty results and structured errors", async () => {
  const args = ["pr", "list", "--repo", "https://github.com/acme/app"];
  const empty = await runPrWithEnv({ PR_LIST_MODE: "empty" }, ...args);
  const emptyJson = await runPrWithEnv({ PR_LIST_MODE: "empty" }, ...args, "--json");
  const denied = await runPrWithEnv({ PR_LIST_MODE: "denied" }, ...args, "--json");
  const invalid = await runPr(...args, "--limit", "0");

  expect(empty.stdout.trim()).toBe("No pull requests.");
  expect(JSON.parse(emptyJson.stdout)).toMatchObject({ ok: true, prs: [] });
  expect(denied.exitCode).toBe(1);
  expect(JSON.parse(denied.stdout)).toMatchObject({ error: { code: "SCM_ACCESS_DENIED" } });
  expect(denied.stdout).not.toContain("secret-token");
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toContain("--limit must be a positive safe integer");
});

test("PR diff declares format and path options and renders patch, stat and JSON", async () => {
  const help = await runCli("pr", "diff", "--help");
  const completion = await runCli("completion", "bash");
  const ref = "https://github.com/acme/app/pull/12";
  const patch = await runPr("pr", "diff", ref);
  const stat = await runPr("pr", "diff", ref, "--format", "stat");
  const jsonFormat = await runPr("pr", "diff", ref, "--format", "json");
  const globalJson = await runPr("pr", "diff", ref, "--format", "json", "--json");
  const filtered = await runPr("pr", "diff", ref, "--path", "src/auth.ts", "--json");

  for (const flag of ["--format", "--path"]) {
    expect(help.stdout).toContain(flag);
    expect(completion.stdout).toContain(flag);
  }
  expect(help.stdout).toContain("patch");
  expect(help.stdout).toContain("may not apply cleanly");
  expect(patch.exitCode).toBe(0);
  expect(patch.stdout).toContain('diff --git "a/src/auth.ts" "b/src/auth.ts"');
  expect(patch.stdout).toContain('--- /dev/null\n+++ "b/src/new file.ts"');
  expect(patch.stdout).toContain('--- "a/src/old\\tfile.ts"\n+++ /dev/null');
  expect(patch.stdout).toContain('# Patch unavailable (not-provided) for "src/rename new.ts"');
  expect(patch.stdout).toContain('a/src/quoted\\"file.ts');
  expect(stat.stdout).toContain("6 file(s) changed");
  expect(jsonFormat.stdout.startsWith("{\n")).toBe(true);
  expect(JSON.parse(jsonFormat.stdout)).toMatchObject({ diff: { baseCommit: "base123" } });
  expect(JSON.parse(jsonFormat.stdout)).not.toHaveProperty("ok");
  expect(JSON.parse(globalJson.stdout)).toMatchObject({
    ok: true,
    diff: { files: expect.any(Array) },
  });
  expect(JSON.parse(globalJson.stdout)).toHaveProperty("dryRun", false);
  expect(JSON.parse(filtered.stdout).diff.files.map((file: { path: string }) => file.path)).toEqual(
    ["src/auth.ts"],
  );
});

test("PR diff preserves empty results and returns structured errors for invalid and unsupported targets", async () => {
  const empty = await runPr(
    "pr",
    "diff",
    "https://github.com/acme/app/pull/12",
    "--path",
    "missing/**",
  );
  const invalid = await runPr(
    "pr",
    "diff",
    "12",
    "--repo",
    "https://github.com/acme/app",
    "--path",
    "../secret",
    "--json",
  );
  const azure = await runPr(
    "pr",
    "diff",
    "https://dev.azure.com/acme/Product/_git/app/pullrequest/42",
    "--json",
  );

  expect(empty.stdout).toBe("No changed files.\n");
  expect(invalid.exitCode).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ error: { code: "SCM_INVALID_OPTIONS" } });
  expect(azure.exitCode).toBe(1);
  expect(JSON.parse(azure.stdout)).toMatchObject({ error: { code: "SCM_UNSUPPORTED_OPERATION" } });
});

test("PR create declares options and renders human and JSON results", async () => {
  const help = await runCli("pr", "create", "--help");
  const completion = await runCli("completion", "bash");
  for (const flag of ["--title", "--base", "--body-file", "--reviewer", "--label"]) {
    expect(help.stdout).toContain(flag);
    expect(completion.stdout).toContain(flag);
  }
  const args = [
    "pr",
    "create",
    "--repo",
    "https://github.com/acme/app",
    "--head",
    "topic",
    "--base",
    "main",
    "--title",
    "New PR",
    "--draft",
  ];
  const human = await runPr(...args);
  const json = await runPr(...args, "--json");

  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("New PR\nhttps://github.com/acme/app/pull/12");
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    pr: { title: "New PR", isDraft: true, ref: { number: 12 } },
  });
});

test("PR create dry-run sends no HTTP requests and errors follow existing output conventions", async () => {
  const args = [
    "pr",
    "create",
    "--repo",
    "https://github.com/acme/app",
    "--head",
    "topic",
    "--base",
    "main",
    "--title",
    "Title",
  ];
  const dry = await runPrWithEnv(
    { PR_FORBID_REQUESTS: "1" },
    ...args,
    "--reviewer",
    "alice",
    "--label",
    "bug",
    "--dry-run",
    "--json",
  );
  const invalid = await runPr(...args, "--body", "", "--body-file", "missing", "--json");
  const azure = await runPr(
    "pr",
    "create",
    "--repo",
    "https://dev.azure.com/acme/project/_git/app",
    "--head",
    "topic",
    "--base",
    "main",
    "--title",
    "Title",
    "--json",
  );

  expect(dry.exitCode).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [{ type: "github-pr-create" }],
  });
  expect(invalid.exitCode).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ error: { code: "SCM_INVALID_OPTIONS" } });
  expect(azure.exitCode).toBe(1);
  expect(JSON.parse(azure.stdout)).toMatchObject({ error: { code: "SCM_UNSUPPORTED_OPERATION" } });
});

test("PR help and completion expose the read commands and show enrichments", async () => {
  const help = await runCli("pr", "--help");
  const completion = await runCli("completion", "bash");
  const showHelp = await runCli("pr", "show", "--help");

  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("show");
  expect(help.stdout).toContain("checks");
  expect(help.stdout).toContain("reviewers");
  expect(help.stdout).toMatch(/\n  merge\s/);
  expect(help.stdout).toMatch(/\n  comments\s/);
  expect(help.stdout).toMatch(/\n  review\s/);
  expect(completion.stdout).toContain("--remote");
  expect(completion.stdout).toContain("--head");
  for (const flag of ["--raw", "--comments", "--checks"]) {
    expect(showHelp.stdout).toContain(flag);
    expect(completion.stdout).toContain(flag);
  }
});

test("PR show enrichments compose in human and JSON output", async () => {
  const args = [
    "pr",
    "show",
    "https://github.com/acme/app/pull/12",
    "--raw",
    "--comments",
    "--checks",
  ];
  const human = await runPr(...args);
  const json = await runPr(...args, "--json", "--dry-run");

  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("alice\nLooks good");
  expect(human.stdout).toContain("passed\tbuild");
  expect(human.stdout).toContain("Raw provider data");
  expect(json.exitCode).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    pr: {
      raw: { number: 12 },
      comments: [{ body: "Looks good" }],
      checks: [{ name: "build" }],
    },
  });
});

test("PR show renders human and JSON success through the real SDK", async () => {
  const human = await runPr("pr", "show", "https://github.com/acme/app/pull/12");
  const json = await runPr("pr", "show", "12", "--repo", "https://github.com/acme/app", "--json");

  expect(human.exitCode).toBe(0);
  expect(human.stderr).toBe("");
  expect(human.stdout).toContain("Improve login");
  expect(human.stdout).toContain("open (draft)");
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    dryRun: false,
    pr: { isDraft: true, ref: { number: 12 } },
  });
});

test("PR discovery, checks and reviewers are independently usable", async () => {
  const show = await runPr(
    "pr",
    "show",
    "--repo",
    "https://github.com/acme/app",
    "--head",
    "topic",
    "--json",
  );
  const checks = await runPr(
    "pr",
    "checks",
    "https://github.com/acme/app/pull/12",
    "--json",
    "--dry-run",
  );
  const reviewers = await runPr("pr", "reviewers", "https://github.com/acme/app/pull/12", "--json");

  expect(JSON.parse(show.stdout)).toMatchObject({ ok: true, pr: { sourceBranch: "topic" } });
  expect(JSON.parse(checks.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    checks: [{ name: "build", state: "passed" }],
  });
  expect(JSON.parse(reviewers.stdout)).toMatchObject({
    ok: true,
    reviews: [{ reviewer: { name: "alice" }, state: "approved" }],
  });
});

test("checks help and completion declare required-only and watch controls", async () => {
  const help = await runCli("pr", "checks", "--help");
  const completion = await runCli("completion", "zsh");

  for (const flag of ["--required-only", "--watch", "--interval", "--timeout"]) {
    expect(help.stdout).toContain(flag);
    expect(completion.stdout).toContain(flag);
  }
});

test("checks watch combines required filtering with polling and emits one final JSON document", async () => {
  const result = await runPrWithEnv(
    { PR_CHECK_MODE: "transition" },
    "pr",
    "checks",
    "https://github.com/acme/app/pull/12",
    "--required-only",
    "--watch",
    "--interval",
    "0.001",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    checks: [{ name: "build", state: "passed" }],
  });
});

test.each(["failed", "cancelled", "unknown"])(
  "checks watch fails explicitly for %s checks",
  async (mode) => {
    const result = await runPrWithEnv(
      { PR_CHECK_MODE: mode },
      "pr",
      "checks",
      "https://github.com/acme/app/pull/12",
      "--watch",
      "--json",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: mode === "unknown" ? "SCM_UNKNOWN_CHECK_STATE" : "SCM_CHECKS_FAILED" },
    });
  },
);

test("checks watch times out and reports absent checks without hanging", async () => {
  const timedOut = await runPrWithEnv(
    { PR_CHECK_MODE: "pending" },
    "pr",
    "checks",
    "https://github.com/acme/app/pull/12",
    "--watch",
    "--timeout",
    "0.01",
    "--json",
  );
  const empty = await runPrWithEnv(
    { PR_CHECK_MODE: "empty" },
    "pr",
    "checks",
    "https://github.com/acme/app/pull/12",
    "--watch",
  );

  expect(timedOut.exitCode).toBe(1);
  expect(JSON.parse(timedOut.stdout)).toMatchObject({
    ok: false,
    error: { code: "SCM_WATCH_TIMEOUT" },
  });
  expect(empty.exitCode).toBe(0);
  expect(empty.stdout).toBe("No checks.\n");
});

test.each(["SIGINT", "SIGTERM"])(
  "checks watch handles %s with structured cancellation and exit 130",
  async (signal) => {
    const result = await runPrWithEnv(
      { PR_CHECK_MODE: "pending", PR_SIGNAL: signal },
      "pr",
      "checks",
      "https://github.com/acme/app/pull/12",
      "--watch",
      "--json",
    );

    expect(result.exitCode).toBe(130);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  },
);

test("checks rejects invalid watch options and renders human failures on stderr", async () => {
  const misplaced = await runPr(
    "pr",
    "checks",
    "https://github.com/acme/app/pull/12",
    "--interval",
    "1",
    "--json",
  );
  const invalid = await runPr(
    "pr",
    "checks",
    "https://github.com/acme/app/pull/12",
    "--watch",
    "--interval",
    "0",
    "--json",
  );
  const failed = await runPrWithEnv(
    { PR_CHECK_MODE: "failed" },
    "pr",
    "checks",
    "https://github.com/acme/app/pull/12",
    "--watch",
  );

  expect(misplaced.exitCode).toBe(1);
  expect(JSON.parse(misplaced.stdout)).toMatchObject({ error: { code: "SCM_INVALID_OPTIONS" } });
  expect(invalid.exitCode).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ error: { code: "SCM_INVALID_OPTIONS" } });
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toContain("Build".toLowerCase());
});

test("PR SDK failures preserve existing Eden JSON error conventions without secrets", async () => {
  const result = await runPr(
    "pr",
    "show",
    "404",
    "--repo",
    "https://github.com/acme/app",
    "--json",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "SCM_NOT_FOUND" } });
  expect(result.stdout).not.toContain("secret-token");
});

test("reviewer help and completion declare both filters", async () => {
  const help = await runCli("pr", "reviewers", "--help");
  const completion = await runCli("completion", "bash");

  for (const flag of ["--pending", "--approved"]) {
    expect(help.stdout).toContain(flag);
    expect(completion.stdout).toContain(flag);
  }
});

test("reviewers filter pending requests and approvals in human and JSON output", async () => {
  const env = { PR_REVIEW_MODE: "mixed" };
  const pending = await runPrWithEnv(
    env,
    "pr",
    "reviewers",
    "https://github.com/acme/app/pull/12",
    "--pending",
    "--json",
  );
  const approved = await runPrWithEnv(
    env,
    "pr",
    "reviewers",
    "https://github.com/acme/app/pull/12",
    "--approved",
  );
  const all = await runPrWithEnv(
    env,
    "pr",
    "reviewers",
    "https://github.com/acme/app/pull/12",
    "--json",
  );

  expect(pending.exitCode).toBe(0);
  expect(JSON.parse(pending.stdout)).toMatchObject({
    ok: true,
    reviews: [
      { reviewer: { id: "user:8", name: "bob" }, state: "pending" },
      { reviewer: { id: "team:1", name: "security" }, state: "pending" },
    ],
  });
  expect(approved.exitCode).toBe(0);
  expect(approved.stdout).toBe("approved\talice\n");
  expect(JSON.parse(all.stdout).reviews).toHaveLength(5);
});

test("reviewers return empty filtered lists without treating absent reviews as an error", async () => {
  const json = await runPrWithEnv(
    { PR_REVIEW_MODE: "empty" },
    "pr",
    "reviewers",
    "https://github.com/acme/app/pull/12",
    "--approved",
    "--json",
    "--dry-run",
  );
  const human = await runPrWithEnv(
    { PR_REVIEW_MODE: "empty" },
    "pr",
    "reviewers",
    "https://github.com/acme/app/pull/12",
    "--pending",
  );

  expect(json.exitCode).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, dryRun: true, reviews: [] });
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toBe("No pending reviewers.\n");
});

test("reviewers reject conflicting filters and preserve structured provider failures", async () => {
  const conflict = await runPr(
    "pr",
    "reviewers",
    "https://github.com/acme/app/pull/12",
    "--pending",
    "--approved",
    "--json",
  );
  const missing = await runPr("pr", "reviewers", "https://github.com/acme/app/pull/404", "--json");
  const human = await runPr(
    "pr",
    "reviewers",
    "https://github.com/acme/app/pull/12",
    "--pending",
    "--approved",
  );

  expect(conflict.exitCode).toBe(1);
  expect(JSON.parse(conflict.stdout)).toMatchObject({
    ok: false,
    error: { code: "SCM_INVALID_OPTIONS" },
  });
  expect(missing.exitCode).toBe(1);
  expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { code: "SCM_NOT_FOUND" } });
  expect(missing.stdout).not.toContain("secret-token");
  expect(human.exitCode).toBe(1);
  expect(human.stdout).toBe("");
  expect(human.stderr).toContain("mutually exclusive");
});

test("unsupported hosts fail before credential or network access", async () => {
  const result = await runCli("pr", "show", "https://evil.test/acme/app/pull/12", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "SCM_INVALID_URL" },
  });
});

async function runPr(...args: string[]) {
  return runPrWithEnv({}, ...args);
}

test("PR help and completion do not expose browser launching", async () => {
  const help = await runCli("pr", "--help");
  const completion = await runCli("completion", "bash");

  expect(help.exitCode).toBe(0);
  expect(help.stdout).not.toMatch(/\n  open\s/);
  expect(help.stdout).not.toContain("--print-url");
  expect(completion.stdout).not.toContain("--print-url");
});

async function runPrWithEnv(env: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, fixture, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_TOKEN: "fake-test-token", ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

test("PR edit help and completion declare supported metadata options", async () => {
  const help = await runCli("pr", "edit", "--help");
  const completion = await runCli("completion", "zsh");

  expect(help.exitCode).toBe(0);
  for (const flag of ["--title", "--body", "--body-file", "--base", "--draft", "--ready"]) {
    expect(help.stdout).toContain(flag);
    expect(completion.stdout).toContain(flag);
  }
});

test("PR edit updates only supplied fields and renders human and JSON success", async () => {
  const ref = "https://github.com/acme/app/pull/12";
  const json = await runPr(
    "pr",
    "edit",
    ref,
    "--body",
    "",
    "--base",
    "release",
    "--ready",
    "--json",
  );
  const human = await runPr("pr", "edit", ref, "--title", "New title");

  expect(json.exitCode).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    pr: { title: "Improve login", body: "", targetBranch: "release", isDraft: false },
  });
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toBe(`New title\n${ref}\n`);
});

test("PR edit dry-run records the exact patch without sending SDK requests", async () => {
  const result = await runPrWithEnv(
    { PR_FORBID_REQUESTS: "1" },
    "pr",
    "edit",
    "12",
    "--repo",
    "https://github.com/acme/app",
    "--body",
    "",
    "--ready",
    "--json",
    "--dry-run",
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    operations: [
      {
        type: "github-pr-edit",
        input: { ref: { number: 12 }, patch: { body: "", isDraft: false } },
      },
    ],
  });
});

test("PR edit rejects no-op patches and flag conflicts, preserving structured provider errors", async () => {
  const ref = "https://github.com/acme/app/pull/12";
  for (const flags of [
    [],
    ["--draft", "--ready"],
    ["--body", "", "--body-file", "missing"],
    ["--title", " "],
  ]) {
    const result = await runPrWithEnv(
      { PR_FORBID_REQUESTS: "1" },
      "pr",
      "edit",
      ref,
      ...flags,
      "--json",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  }
  const missing = await runPr(
    "pr",
    "edit",
    "https://github.com/acme/app/pull/404",
    "--title",
    "Updated",
    "--json",
  );

  expect(missing.exitCode).toBe(1);
  expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { code: "SCM_NOT_FOUND" } });
  expect(missing.stdout).not.toContain("secret-token");
});

test("PR edit reads body-file through the CLI and requires an explicit PR target", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "body.md");
    await Bun.write(path, "New description\n");

    const result = await runPr(
      "pr",
      "edit",
      "https://github.com/acme/app/pull/12",
      "--body-file",
      path,
      "--json",
    );
    const absent = await runPr("pr", "edit", "--title", "Updated", "--json");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pr: { body: "New description\n" } });
    expect(absent.exitCode).toBe(1);
    expect(JSON.parse(absent.stdout).ok).toBe(false);
  });
});

test("PR status composes live state, reviewers and checks in human and JSON output", async () => {
  const ref = "https://github.com/acme/app/pull/12";
  const human = await runPr("pr", "status", ref);
  const json = await runPr(
    "pr",
    "status",
    "--repo",
    "https://github.com/acme/app",
    "--head",
    "topic",
    "--refresh",
    "--json",
    "--dry-run",
  );
  const help = await runCli("pr", "status", "--help");
  const completion = await runCli("completion", "bash");

  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("open (draft)");
  expect(human.stdout).toContain("approved\talice");
  expect(human.stdout).toContain("passed\tbuild");
  expect(json.exitCode).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    dryRun: true,
    pr: { ref: { number: 12 } },
    reviews: [{ state: "approved" }],
    checks: [{ state: "passed" }],
  });
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("--refresh");
  expect(completion.stdout).toContain("--refresh");
});

test("PR status renders absent reviews and checks and preserves missing-PR errors", async () => {
  const empty = await runPrWithEnv(
    { PR_REVIEW_MODE: "empty", PR_CHECK_MODE: "empty" },
    "pr",
    "status",
    "https://github.com/acme/app/pull/12",
  );
  const missing = await runPr("pr", "status", "https://github.com/acme/app/pull/404", "--json");

  expect(empty.exitCode).toBe(0);
  expect(empty.stdout).toContain("No reviewers.");
  expect(empty.stdout).toContain("No checks.");
  expect(missing.exitCode).toBe(1);
  expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { code: "SCM_NOT_FOUND" } });
});

test("PR reopen handles closed, open and merged PRs through human and JSON output", async () => {
  const ref = "https://github.com/acme/app/pull/12";
  const reopened = await runPrWithEnv({ PR_STATE: "closed" }, "pr", "reopen", ref, "--json");
  const open = await runPr("pr", "reopen", ref);
  const merged = await runPrWithEnv({ PR_STATE: "merged" }, "pr", "reopen", ref, "--json");
  const dryRun = await runPrWithEnv(
    { PR_FORBID_REQUESTS: "1" },
    "pr",
    "reopen",
    ref,
    "--json",
    "--dry-run",
  );
  const help = await runCli("pr", "reopen", "--help");
  const completion = await runCli("completion", "bash");

  expect(reopened.exitCode).toBe(0);
  expect(JSON.parse(reopened.stdout)).toMatchObject({ ok: true, pr: { state: "open" } });
  expect(open.exitCode).toBe(0);
  expect(open.stdout).toContain(`open\n${ref}`);
  expect(merged.exitCode).toBe(1);
  expect(JSON.parse(merged.stdout)).toMatchObject({
    ok: false,
    error: { code: "SCM_INVALID_STATE" },
  });
  expect(dryRun.exitCode).toBe(0);
  expect(JSON.parse(dryRun.stdout)).toMatchObject({
    ok: true,
    operations: [{ type: "github-pr-reopen" }],
  });
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("Exact PR number or URL");
  expect(completion.stdout).toContain("reopen");
});
