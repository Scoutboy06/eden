import { expect, mock, test } from "bun:test";
import { watchChecks } from "../watch";
import type { PullRequestCheck } from "../provider";

const check = (state: PullRequestCheck["state"]): PullRequestCheck => ({
  id: "build",
  name: "Build",
  state,
});

test("watch polls pending and running checks until they pass", async () => {
  const states: PullRequestCheck["state"][] = ["pending", "running", "passed"];
  const read = mock(async () => [check(states.shift() ?? "passed")]);

  expect(await watchChecks(read, { intervalMs: 1 })).toEqual([check("passed")]);
  expect(read).toHaveBeenCalledTimes(3);
});

test.each(["failed", "cancelled", "unknown"] as const)(
  "watch reports terminal %s states",
  async (state) => {
    await expect(watchChecks(async () => [check(state)])).rejects.toMatchObject({
      code: state === "unknown" ? "SCM_UNKNOWN_CHECK_STATE" : "SCM_CHECKS_FAILED",
    });
  },
);

test.each([[[]], [[check("skipped")]]])(
  "watch finishes when no checks need polling",
  async (checks) => {
    const read = mock(async () => checks);

    expect(await watchChecks(read)).toEqual(checks);
    expect(read).toHaveBeenCalledTimes(1);
  },
);

test("watch waits for every check before reporting failure", async () => {
  let calls = 0;

  await expect(
    watchChecks(async () => [check("failed"), check(++calls === 1 ? "running" : "passed")], {
      intervalMs: 1,
    }),
  ).rejects.toMatchObject({ code: "SCM_CHECKS_FAILED" });
  expect(calls).toBe(2);
});

test("watch propagates provider failures without retrying", async () => {
  const read = mock(async (): Promise<PullRequestCheck[]> => {
    throw new Error("Provider failed");
  });

  await expect(watchChecks(read)).rejects.toThrow("Provider failed");
  expect(read).toHaveBeenCalledTimes(1);
});

test("watch can be cancelled during polling sleep", async () => {
  const controller = new AbortController();
  const read = mock(async () => {
    setTimeout(() => controller.abort(), 1);
    return [check("pending")];
  });

  await expect(watchChecks(read, { signal: controller.signal })).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(read).toHaveBeenCalledTimes(1);
});

test("watch cancels in-flight reads and does not fetch with an already aborted signal", async () => {
  const controller = new AbortController();
  const read = mock(() => new Promise<PullRequestCheck[]>(() => {}));
  const result = watchChecks(read, { signal: controller.signal });

  controller.abort();

  await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
  await expect(watchChecks(read, { signal: controller.signal })).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(read).toHaveBeenCalledTimes(1);
});

test("watch timeout interrupts in-flight reads", async () => {
  await expect(watchChecks(() => new Promise(() => {}), { timeoutMs: 5 })).rejects.toMatchObject({
    code: "SCM_WATCH_TIMEOUT",
  });
});

test.each([0, -1, Infinity, NaN, 2_147_483_648])(
  "watch rejects invalid duration %s",
  async (value) => {
    const read = mock(async () => []);

    await expect(watchChecks(read, { intervalMs: value })).rejects.toMatchObject({
      code: "SCM_INVALID_OPTIONS",
    });
    await expect(watchChecks(read, { timeoutMs: value })).rejects.toMatchObject({
      code: "SCM_INVALID_OPTIONS",
    });
    expect(read).not.toHaveBeenCalled();
  },
);
