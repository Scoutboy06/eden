import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runCli } from "./support/cli";

const fixture = fileURLToPath(new URL("./fixtures/pr.ts", import.meta.url));

test("PR help and completion expose the read commands and show enrichments", async () => {
  const help = await runCli("pr", "--help");
  const completion = await runCli("completion", "bash");
  const showHelp = await runCli("pr", "show", "--help");

  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("show");
  expect(help.stdout).toContain("checks");
  expect(help.stdout).toContain("reviewers");
  expect(help.stdout).not.toContain("merge");
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
