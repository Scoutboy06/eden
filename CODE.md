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
