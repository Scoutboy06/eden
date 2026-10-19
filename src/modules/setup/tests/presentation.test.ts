import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { ReadinessCheck } from "../../sandbox/readiness";
import { formatReadiness } from "../presentation";

const checks: ReadinessCheck[] = [
  {
    id: "login",
    checkingLabel: "Checking login",
    skippedLabel: "Login not checked",
    dependencies: [],
    run: async () => ({ state: "ready", label: "Signed in" }),
  },
];

test("unresolved checks show an inline retry countdown", () => {
  const output = formatReadiness(
    {
      id: "login",
      result: { state: "missing", label: "Sign-in required" },
      checking: false,
      retryIn: 8,
    },
    checks,
    0,
  );

  expect(stripVTControlCharacters(output)).toBe("! Sign-in required (8s)");
});

test("refreshing an unresolved check keeps its previous text with a spinner", () => {
  const output = formatReadiness(
    { id: "login", result: { state: "missing", label: "Sign-in required" }, checking: true },
    checks,
    1,
  );

  expect(stripVTControlCharacters(output)).toBe("! Sign-in required ◓");
});

test("successful checks refresh silently without a spinner or countdown", () => {
  const output = formatReadiness(
    { id: "login", result: { state: "ready", label: "Signed in" }, checking: true, retryIn: 8 },
    checks,
    2,
  );

  expect(stripVTControlCharacters(output)).toBe("✓ Signed in");
});

test("initial checks show loading; skipped checks do not imply a failed prerequisite", () => {
  const result = { state: "skipped", label: "Login not checked" } as const;
  const pending = formatReadiness({ id: "login", result, checking: true }, checks, 0);
  const skipped = formatReadiness({ id: "login", result, checking: false, retryIn: 8 }, checks, 0);

  expect(stripVTControlCharacters(pending)).toBe("◐ Checking login");
  expect(stripVTControlCharacters(skipped)).toBe("— Login not checked");
});

test("timeouts use a concise status and retry countdown", () => {
  const output = formatReadiness(
    {
      id: "login",
      result: { state: "timeout", label: "Check timed out" },
      checking: false,
      retryIn: 9,
    },
    checks,
    0,
  );

  expect(stripVTControlCharacters(output)).toBe("? Check timed out (9s)");
});
