import { expect, test } from "bun:test";
import { runCli } from "./support/cli";
import { runPr, runPrWithEnv } from "./support/pr-runner";

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
