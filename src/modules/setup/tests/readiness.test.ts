import { expect, test } from "bun:test";
import type { ReadinessCheck, ReadinessResult } from "../../sandbox/readiness";
import { ReadinessMonitor } from "../readiness";
import { ManualClock } from "./support/clock";

function check(
  id: string,
  run: ReadinessCheck["run"],
  dependencies: string[] = [],
): ReadinessCheck {
  return {
    id,
    run,
    dependencies,
    checkingLabel: `Checking ${id}`,
    skippedLabel: `${id} not checked`,
  };
}

test("independent checks start concurrently and publish results independently", async () => {
  const clock = new ManualClock();
  const started: string[] = [];
  let finishPolicy: ((result: ReadinessResult) => void) | undefined;
  const monitor = new ReadinessMonitor(
    [
      check("installation", async () => ({ state: "ready", label: "Installed" })),
      check(
        "login",
        async () => {
          started.push("login");
          return { state: "ready", label: "Signed in" };
        },
        ["installation"],
      ),
      check(
        "policy",
        () => {
          started.push("policy");
          return new Promise((resolve) => {
            finishPolicy = resolve;
          });
        },
        ["installation"],
      ),
    ],
    clock,
  );

  monitor.start(() => {});
  await clock.settle();

  expect(started).toEqual(["login", "policy"]);
  expect(monitor.snapshot().find((state) => state.id === "login")).toMatchObject({
    result: { state: "ready" },
    checking: false,
  });
  expect(monitor.snapshot().find((state) => state.id === "policy")?.checking).toBe(true);

  finishPolicy?.({ state: "missing", label: "Policy required" });
  await clock.settle();

  expect(monitor.snapshot().find((state) => state.id === "policy")).toMatchObject({
    result: { state: "missing" },
    retryIn: 10,
  });
  monitor.stop();
  expect(clock.pendingTasks).toBe(0);
});

test("missing prerequisites skip dependent checks", async () => {
  const clock = new ManualClock();
  let calls = 0;
  const monitor = new ReadinessMonitor(
    [
      check("installation", async () => ({ state: "missing", label: "Not installed" })),
      check(
        "login",
        async () => {
          calls++;
          return { state: "ready", label: "Signed in" };
        },
        ["installation"],
      ),
    ],
    clock,
  );

  monitor.start(() => {});
  await clock.settle();

  expect(calls).toBe(0);
  expect(monitor.snapshot()[1]?.result).toMatchObject({ state: "skipped" });
  monitor.stop();
});

test("polling retries after ten seconds and retains the prior result while refreshing", async () => {
  const clock = new ManualClock();
  let calls = 0;
  let finish: ((result: ReadinessResult) => void) | undefined;
  const monitor = new ReadinessMonitor(
    [
      check("login", () => {
        calls++;
        return calls === 1
          ? Promise.resolve({ state: "missing", label: "Sign-in required" })
          : new Promise((resolve) => {
              finish = resolve;
            });
      }),
    ],
    clock,
  );

  monitor.start(() => {});
  await clock.settle();
  await clock.advance(2000);

  expect(calls).toBe(1);
  expect(monitor.snapshot()[0]?.retryIn).toBe(8);

  await clock.advance(8000);

  expect(calls).toBe(2);
  expect(monitor.snapshot()[0]).toMatchObject({
    result: { state: "missing", label: "Sign-in required" },
    checking: true,
  });

  finish?.({ state: "ready", label: "Signed in" });
  await clock.settle();

  expect(monitor.snapshot()[0]).toMatchObject({ result: { state: "ready" }, retryIn: undefined });
  monitor.stop();
});

test("a five-second deadline cancels a stalled check without overlapping attempts", async () => {
  const clock = new ManualClock();
  let calls = 0;
  let aborted = 0;
  const monitor = new ReadinessMonitor(
    [
      check("policy", (signal) => {
        calls++;
        signal.addEventListener("abort", () => {
          aborted++;
        });
        return new Promise(() => {});
      }),
    ],
    clock,
  );

  monitor.start(() => {});
  await clock.settle();
  await clock.advance(4999);

  expect(calls).toBe(1);
  expect(aborted).toBe(0);

  await clock.advance(1);

  expect(aborted).toBe(1);
  expect(monitor.snapshot()[0]).toMatchObject({
    result: { state: "timeout" },
    checking: false,
    retryIn: 10,
  });

  await clock.advance(10_000);

  expect(calls).toBe(2);
  monitor.stop();
  expect(clock.pendingTasks).toBe(0);
});

test("leaving cancels lookups and polling; reopening refreshes retained results", async () => {
  const clock = new ManualClock();
  let calls = 0;
  let aborted = 0;
  let finishOld: ((result: ReadinessResult) => void) | undefined;
  const monitor = new ReadinessMonitor(
    [
      check("login", (signal) => {
        calls++;
        if (calls === 1) return Promise.resolve({ state: "missing", label: "Sign-in required" });
        signal.addEventListener("abort", () => {
          aborted++;
        });
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      }),
    ],
    clock,
  );

  monitor.start(() => {});
  await clock.settle();
  await clock.advance(10_000);
  monitor.stop();
  finishOld?.({ state: "ready", label: "Stale result" });
  await clock.advance(30_000);

  expect(aborted).toBe(1);
  expect(calls).toBe(2);
  expect(clock.pendingTasks).toBe(0);
  expect(monitor.snapshot()[0]).toMatchObject({
    result: { state: "missing" },
    checking: false,
    retryIn: undefined,
  });

  monitor.start(() => {});
  await clock.settle();

  expect(calls).toBe(3);
  expect(monitor.snapshot()[0]).toMatchObject({ result: { state: "missing" }, checking: true });
  monitor.stop();
});

test("unexpected check errors become informational failures", async () => {
  const clock = new ManualClock();
  const monitor = new ReadinessMonitor(
    [
      check("policy", async () => {
        throw new Error("Unexpected response");
      }),
    ],
    clock,
  );

  monitor.start(() => {});
  await clock.settle();

  expect(monitor.snapshot()[0]?.result).toEqual({
    state: "unknown",
    label: "Check failed",
    instructions: ["Unexpected response"],
  });
  monitor.stop();
});
