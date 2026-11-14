import { expect, test } from "bun:test";
import { runCli } from "./support/cli";
import { runPr } from "./support/pr-runner";

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

test("PR help and completion do not expose browser launching", async () => {
  const help = await runCli("pr", "--help");
  const completion = await runCli("completion", "bash");

  expect(help.exitCode).toBe(0);
  expect(help.stdout).not.toMatch(/\n  open\s/);
  expect(help.stdout).not.toContain("--print-url");
  expect(completion.stdout).not.toContain("--print-url");
});
