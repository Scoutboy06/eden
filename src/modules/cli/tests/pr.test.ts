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

test("unsupported hosts fail before credential or network access", async () => {
  const result = await runCli("pr", "show", "https://evil.test/acme/app/pull/12", "--json");

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "SCM_INVALID_URL" },
  });
});

async function runPr(...args: string[]) {
  const child = Bun.spawn([process.execPath, fixture, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_TOKEN: "fake-test-token" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}
