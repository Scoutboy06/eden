import { expect, test } from "bun:test";
import { runCli } from "./support/cli";
import { runPr, runPrWithEnv } from "./support/pr-runner";
import { formatReviewThreads } from "../../../../apps/cli/src/commands/pr-output";

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

test("PR comments human output labels Azure current and original diff sides while JSON retains both", () => {
  const result = {
    threads: [
      [
        {
          id: "17:23",
          body: "Tracked discussion",
          author: { id: "alice", name: "Alice" },
          threadId: "17",
          isResolved: false,
          location: {
            tracked: {
              path: "/src/new.ts",
              right: { start: { line: 9, offset: 2 }, end: { line: 10, offset: 4 } },
            },
            original: {
              path: "/src/old.ts",
              left: { start: { line: 3 }, end: { line: 4 } },
            },
          },
        },
      ],
      [
        {
          id: "18:24",
          body: "Original fallback",
          author: null,
          threadId: "18",
          location: { original: { path: "/src/older.ts", left: { start: { line: 12 } } } },
        },
      ],
    ],
    hasMore: false,
    incomplete: false,
  };

  const human = formatReviewThreads(result);
  const json = JSON.parse(JSON.stringify(result));

  expect(human).toContain("/src/new.ts:9 [right/new side]");
  expect(human).toContain("/src/older.ts:12 [original left/old side]");
  expect(human).not.toContain("18:24 (unresolved)");
  expect(json.threads[0][0].location).toMatchObject({
    tracked: { right: { start: { line: 9, offset: 2 }, end: { line: 10, offset: 4 } } },
    original: { left: { start: { line: 3 }, end: { line: 4 } } },
  });
});
