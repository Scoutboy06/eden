# Coding standards

Do not write code comments; make the code explain itself through clear names and structure.

Separate logical blocks with one blank line, including setup, action, and assertions in tests.

After imports and supporting types, place the file's primary class or function before its implementation helpers.

## Test placement

Place module tests in a `tests/` folder inside the module, not alongside its
implementation files or in a separate sibling test module. Name test files
`*.test.ts`, and use that suffix only for files containing tests. Mirror the
implementation's file and folder structure under `tests/` where applicable.

Keep test helpers in `tests/support/` and executable fixtures in `tests/fixtures/`,
as ordinary `.ts` files. Write fixtures as real TypeScript rather than source code
inside strings. Keep assertions in the tests, not in helpers.

## Running tests

- `bun run test:fast` runs in-process logic, service and adapter contracts, including
  isolated filesystem tests. Use it while editing.
- `bun run test:integration` runs real CLI, Git (including PR resolution), shell, environment and process-lifecycle
  tests. Git and Bun must be on PATH; shell completion tests also need their shell.
- `bun run test:full` (or the compatible `bun run test`) runs everything in one Bun
  process. It remains required before merging and runs in `.husky/pre-push`.
- `bun run test:fast --list` and `bun run test:integration --list` show the exact
  file partition. Both commands forward other arguments, such as `--test-name-pattern`,
  to Bun. Classification lives in `scripts/test-groups.ts`: keep new real-process
  suites in integration. The partition test checks discovery, coverage and overlap.
- `bun run test:profile full 2` records two sequential, isolated per-file wall-clock
  samples as JSON. Replace `full` with `fast` or `integration` as needed. This includes
  a fresh Bun startup for each file; do not compare its total directly with a single
  full-suite run. Record the environment and repeat comparable commands when tuning.

Tool/platform-dependent skips must have an explicit reason and be reported alongside
the result. Install missing declared dependencies with `bun install --frozen-lockfile`;
missing dependencies are not evidence of a product regression. On hosts without
PowerShell, its completion integration cases skip but generator assertions still run.

`bunfig.toml` preloads `scripts/test-environment.ts` for every Bun test run. It removes
inherited `GIT_*` controls before tests import code or spawn commands: Git hooks export
repository/index variables that would otherwise redirect temporary-repository commands
into the caller's checkout. Do not bypass this isolation when adding test entry points.

## Choosing tests

Before adding a test, name the plausible mistake it catches, the observable contract
it asserts, and whether an existing test already protects that behavior. Choose the
cheapest boundary that can catch it:

- Put detailed configuration and precedence matrices in service tests. For example,
  `src/modules/config/tests/profile-edits.test.ts` checks string-like YAML values and
  literal keys without launching a CLI per value. Keep representative CLI tests to
  prove argument wiring, output, errors, JSON and dry-run behavior.
- Test HTTP endpoints, commit refs, query parameters and normalized responses at the
  adapter boundary. Do not assert unrelated SDK internals or concurrent request order.
- Retain real CLI, shell, terminal, timeout, cancellation and descendant-cleanup tests
  when the process boundary is the behavior being protected. Prefer readiness/exit
  signals to arbitrary sleeps; do not remove genuine deadline or grace-period checks.

Partial assertions and mocks are intentional when omitted fields are irrelevant or an
external service is not the subject. Strengthen assertions that could accept the wrong
route or request; avoid blanket snapshots. Use isolated temporary state and reliable
cleanup, not shared mutable repositories or unbounded concurrency. Move overlapping
cases only with equivalent protection at the new boundary; do not target a test count
or coverage percentage. See `docs/testing-performance.md` for the measured migration.
