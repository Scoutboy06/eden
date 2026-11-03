# Test feedback work: eden-xed

Measured November 3, 2026 against baseline `b9a7d92`, on the same Linux x86_64 host
(kernel 7.2.11-arch1-1), Bun 1.4.3, Git 2.56.0, Bash 5.3.20 and Zsh 5.9.2.
Dependencies were checked with `bun install --frozen-lockfile` (no lockfile changes).
PowerShell was unavailable. No Docker daemon, cloud credentials or live provider
services were used: integration tests use isolated executable fixtures.

## Baseline

Two `bun test` runs passed: **102.68 s and 94.54 s**, each with 739 passing tests,
seven PowerShell integration skips, zero failures and 1,973 assertions across 60 files.
The earlier audit's dependency errors and unexpected progress/stderr failure did not
reproduce in either dependency-complete run. Existing silent-success and JSON stderr
assertions were kept; no arbitrary stderr was allowed to make the baseline pass.

Ranked accumulated test-body durations from the first full run (not whole-file wall
time; excludes module import/startup overhead):

| File under `src/`                                      | Seconds |
| ------------------------------------------------------ | ------: |
| modules/cli/tests/pr.test.ts                           |   11.63 |
| modules/cli/tests/config-profiles.test.ts              |    6.53 |
| modules/cli/tests/profile-template-update.test.ts      |    6.05 |
| modules/cli/tests/completion/zsh.test.ts               |    5.86 |
| modules/cli/tests/config-set.test.ts                   |    5.48 |
| modules/cli/tests/hooks.test.ts                        |    5.11 |
| external/docker-sbx/tests/docker-sbx-lifecycle.test.ts |    4.63 |
| modules/cli/tests/sbx-hooks.test.ts                    |    4.27 |
| modules/cli/tests/sbx-profiles.test.ts                 |    4.03 |
| modules/cli/tests/config-layers.test.ts                |    3.75 |

Two additional isolated, sequential runs measured actual wall time from immediately
before `Bun.spawn([process.execPath, "test", "./<file>"])` until exit and drained output:

| CLI file                | Before run 1 | Before run 2 |
| ----------------------- | -----------: | -----------: |
| config-layers.test.ts   |      3.421 s |      3.422 s |
| config-profiles.test.ts |      6.098 s |      5.938 s |

These identify concrete process-heavy matrices, not a universal performance target.
Other large files protect distinct PR polling, template update, shell or lifecycle
contracts and were not deleted simply because they were slow.

## Final measurements

Two unfiltered `bun run test:full` runs passed in **89.32 s and 85.88 s**: 744 pass,
seven PowerShell skips, zero failures, 1,969 assertions and 751 tests across 64 files.
The count changes reflect moved matrices plus retained representative CLI cases and
the new partition checks, not a target for test count or assertion count.

The final partition is 28 fast files (388 tests, no skips) and 36 integration files
(363 tests, including the seven PowerShell skips). Two final fast runs took **0.717 s
and 0.724 s**. This is a smaller feedback loop, not a substitute for full coverage.
The final integration command passed in 88.07 s: 356 pass, seven skips, zero failures,
and 1,192 assertions. Its 363 tests plus the fast group's 388 equal the full run's 751;
the 36 integration files plus 28 fast files equal all 64 full-suite files.

Isolated after timings include the replacement service suites, not just the smaller
CLI files. They use the same sequential per-file spawn/exit measurement as before:

| Suite                                                 | After run 1 | After run 2 |
| ----------------------------------------------------- | ----------: | ----------: |
| CLI config-layers.test.ts                             |     1.016 s |     1.002 s |
| CLI config-profiles.test.ts                           |     1.549 s |     1.386 s |
| Config repository-layers.test.ts (replacement matrix) |     0.092 s |     0.087 s |
| Config profile-edits.test.ts (replacement matrices)   |     0.165 s |     0.155 s |
| Combined changed suites                               |     2.822 s |     2.631 s |

The original two CLI suites combined took 9.519 s and 9.359 s. Both observed full-run
and isolated-suite costs decreased, with substantial host/run variability; these are
local samples, not a guaranteed speedup on other machines.

`bun run test:profile full 1` also passed all 64 isolated files. The largest wall
samples were PR CLI (9.736 s), hooks CLI (6.124 s), Zsh completion (5.974 s), config-set
CLI (5.582 s), template update CLI (4.834 s), and Docker lifecycle (4.702 s). Total
isolated-file wall time was 95.288 s; fresh process/import overhead makes this a
different measurement from a single full run. `bun run test:profile fast 2` exercises
the repeated-sampling path as well.

`bun run check` passed lint, formatting and analysis. Analysis still reports existing
private-type/dependency advisories. The extra root `bunx tsc --noEmit` check reports
errors only under unmodified `apps/web-ui` (its root-project alias/DOM/import-meta
configuration); no `src/` or `scripts/` diagnostics remain. That unrelated type-check
configuration was not changed to make this testing work pass.

## Coverage-preserving changes

- `config-layers.test.ts`: reduce ten cases to three real CLI contracts: nested local
  sandbox dry-run/JSON, nested local worktree dry-run/JSON with no branch or directory
  mutation, and global writes with local reads. The six root/nested × global/repository/
  local combinations now run in `config/tests/repository-layers.test.ts`, checking
  agent, sandbox provider, worktree root and winning-file provenance. Existing layer
  tests still cover missing files, empty mappings, invalid lower layers and dry-run writes.
  CLI startups fall from 20 to six and isolated Git initializations from ten to three
  (the repository helper runs four Git setup commands per initialization).
- `config-profiles.test.ts`: retain dotted-key wiring, a literal `__proto__` key,
  typed-YAML-to-string output and a structured validation error at the CLI boundary.
  All three dangerous/escaped names, seven string-like values and eight invalid paths/
  values are checked in `config/tests/profile-edits.test.ts`, including comments,
  read-back values and unchanged files on error. CLI startups fall from 41 to ten.
- Move the existing HOME/XDG and explicit-repository subprocess cases unchanged into
  `config/tests/environment.test.ts`. Remaining config suites are genuinely in-process;
  these environment isolation checks remain integration tests.
- PR lookup now asserts the branch query, one search before one fetch, provider
  construction and the selected PR number (37, deliberately different from fixture 12).
  GitHub checks assert both exact commit-derived check/status endpoints, latest-run
  filtering and page size, alongside the existing normalized-result assertions.
  Concurrent check/status request order is deliberately not asserted.

Three temporary production mutations were each rejected by the strengthened tests:
skipping branch discovery, fetching fixture PR 12 instead of selected PR 37, and
requesting checks/statuses for `wrong-commit` instead of the PR's SHA. Each produced
one failing targeted test; the mutations were reverted before the final full runs.

No production code, polling deadline, cancellation, terminal or process-cleanup test
was changed. Readiness polling in helpers and real grace periods were inspected and
retained; there was no measured arbitrary sleep to remove safely. No shared mutable
fixtures or new test concurrency were introduced.

## Reproduction and partition

Use `bun run test:fast --list` / `bun run test:integration --list` to inspect the current
classification. Discovery skips hidden and dependency directories and includes every
repository `*.test.ts`. CLI (except in-process output), Git worktree, script runner,
config environment, PR resolution (which includes a real Git context case), and Docker process-lifecycle suites are integration; the rest are
fast in-process contracts. The partition tests check exact coverage and no overlap.
`bun run test:full` and the original `bun run test` both remain unfiltered `bun test`;
the pre-push hook explicitly runs the full command, never just the fast subset.

Run `bun run test:profile full 2 > /tmp/eden-test-profile.json` for ranked isolated
per-file wall samples. Do not time multiple suites concurrently, and compare repeated
same-command runs: full-run import sharing and host variability affect totals.

This implements the overlapping profiling, split and avoidable-wait scope of related
task `eden-07i` without a second competing runner. Beads' configured Dolt host was
unreachable during this work; task acceptance criteria were recovered from the task
creation record rather than invented, and tracker status was not assumed updated.
