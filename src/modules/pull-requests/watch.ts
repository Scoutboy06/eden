import { setTimeout as sleep } from "node:timers/promises";
import { ScmError } from "./errors";
import type { PullRequestCheck } from "./provider";

export interface WatchOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
}

export async function watchChecks(
  read: (signal: AbortSignal) => Promise<PullRequestCheck[]>,
  options: WatchOptions = {},
): Promise<PullRequestCheck[]> {
  const intervalMs = options.intervalMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  for (const value of [intervalMs, timeoutMs]) {
    if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)
      throw new ScmError(
        "SCM_INVALID_OPTIONS",
        "Watch interval and timeout must be positive durations below 25 days.",
      );
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;

  try {
    for (;;) {
      const checks = await readUntilAborted(read, signal);
      if (checksFinished(checks)) return checks;

      await sleep(intervalMs, undefined, { signal });
    }
  } catch (error) {
    if (options.signal?.aborted)
      throw new ScmError("CANCELLED", "Watching PR checks was cancelled.");
    if (deadline.signal.aborted)
      throw new ScmError("SCM_WATCH_TIMEOUT", "Timed out waiting for PR checks.");

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function checksFinished(checks: PullRequestCheck[]): boolean {
  const unknown = checks.filter((check) => check.state === "unknown");
  if (unknown.length > 0)
    throw new ScmError(
      "SCM_UNKNOWN_CHECK_STATE",
      `Cannot watch checks with unknown states: ${unknown.map((check) => check.name).join(", ")}.`,
    );
  if (checks.some((check) => check.state === "pending" || check.state === "running")) return false;
  const failed = checks.filter((check) => check.state === "failed" || check.state === "cancelled");
  if (failed.length > 0)
    throw new ScmError(
      "SCM_CHECKS_FAILED",
      `Checks did not pass: ${failed.map((check) => `${check.name} (${check.state})`).join(", ")}.`,
    );

  return true;
}

async function readUntilAborted(
  read: (signal: AbortSignal) => Promise<PullRequestCheck[]>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([read(signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
