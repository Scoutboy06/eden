import { expect, test } from "bun:test";

import { preserveStaleWorktreeData, type WorktreeProjection } from "./worktrees";

const cached: WorktreeProjection = {
  name: "topic",
  branch: "feature/topic",
  state: "available",
  pr: {
    ref: { provider: "github", number: 12 },
    title: "Improve login",
    url: "https://github.com/acme/app/pull/12",
    state: "open",
    isDraft: false,
  },
  reviews: [{ name: "alice", state: "approved" }],
  checks: [{ name: "build", state: "passed" }],
};

test("retains the consumer's last good PR snapshot when refresh is unavailable", () => {
  expect(
    preserveStaleWorktreeData(
      [{ name: "topic", branch: "feature/topic", state: "unavailable", failure: "provider" }],
      [cached],
    ),
  ).toEqual([{ ...cached, failure: "provider", stale: true }]);
});

test("fills failed partial check reads from the cached sidebar snapshot and marks them stale", () => {
  expect(
    preserveStaleWorktreeData(
      [
        {
          ...cached,
          reviews: undefined,
          failure: "access-denied",
        },
      ],
      [cached],
    ),
  ).toEqual([{ ...cached, failure: "access-denied", stale: true }]);
});
