import { expect, test } from "bun:test";
import { runCli } from "./support/cli";
import { runPr, runPrWithEnv } from "./support/pr-runner";

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
  const emptyOutput = empty.stdout.trim();

  expect(emptyOutput).toBe("No pull requests.");
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
  const filteredResponse = JSON.parse(filtered.stdout);
  const filteredDiff = filteredResponse.diff;
  const filteredPaths = filteredDiff.files.map((file: { path: string }) => file.path);

  expect(filteredPaths).toEqual(["src/auth.ts"]);
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
    const expectedErrorCode = mode === "unknown" ? "SCM_UNKNOWN_CHECK_STATE" : "SCM_CHECKS_FAILED";

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: expectedErrorCode },
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
  expect(failed.stderr).toContain("build");
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
  const allResponse = JSON.parse(all.stdout);
  const allReviews = allResponse.reviews;

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
  expect(allReviews).toHaveLength(5);
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
