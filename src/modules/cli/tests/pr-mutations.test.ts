import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCli } from "./support/cli";
import { runPr, runPrWithEnv } from "./support/pr-runner";

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

test("PR review and merge require explicit valid choices and render verified mutations", async () => {
  const reviewHelp = await runCli("pr", "review", "--help");
  const mergeHelp = await runCli("pr", "merge", "--help");
  const expectedHead = "a".repeat(40);
  const reviewArgs = ["pr", "review", "https://github.com/acme/app/pull/12", "--event", "approve"];
  const review = await runPr(...reviewArgs, "--json");
  const reviewDryRun = await runPrWithEnv(
    { PR_FORBID_REQUESTS: "1" },
    ...reviewArgs,
    "--expected-head",
    expectedHead,
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
    operations: [{ type: "github-pr-review", input: { expectedHead } }],
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
  const expectedHumanOutput = `New title\n${ref}\n`;
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
  expect(human.stdout).toBe(expectedHumanOutput);
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
    const response = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(response.ok).toBe(false);
  }
  const missing = await runPr(
    "pr",
    "edit",
    "https://github.com/acme/app/pull/404",
    "--title",
    "Updated",
    "--json",
  );
  const missingResponse = JSON.parse(missing.stdout);

  expect(missing.exitCode).toBe(1);
  expect(missingResponse).toMatchObject({ ok: false, error: { code: "SCM_NOT_FOUND" } });
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
    const absentResponse = JSON.parse(absent.stdout);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pr: { body: "New description\n" } });
    expect(absent.exitCode).toBe(1);
    expect(absentResponse.ok).toBe(false);
  });
});

test("PR reopen handles closed, open and merged PRs through human and JSON output", async () => {
  const ref = "https://github.com/acme/app/pull/12";
  const expectedOpenOutput = `open\n${ref}`;
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
  expect(open.stdout).toContain(expectedOpenOutput);
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
