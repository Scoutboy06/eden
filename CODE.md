# Coding standards

## Test placement

Place module tests in a `tests/` folder inside the module, not alongside its
implementation files or in a separate sibling test module. Name test files
`*.test.ts`, and use that suffix only for files containing tests. Mirror the
implementation's file and folder structure under `tests/` where applicable.

Keep test helpers in `tests/support/` and executable fixtures in `tests/fixtures/`,
as ordinary `.ts` files. Write fixtures as real TypeScript rather than source code
inside strings. Keep assertions in the tests, not in helpers.

## CLI commands

- Put commands in `apps/cli/src/commands/` and declare them with `defineCommand`.
- Read global flags from `ctx.extensions.eden`.
- Route mutations through the execution boundary for dry-run support.
- Use CLI output/error helpers; services should not print.
- Derive completion from command declarations.

```ts
export default defineCommand({
  name: "mkdir",
  description: "Create a directory",
  args: {
    path: { type: "positional", required: true },
  },

  async run(ctx) {
    const { dryRun, json } = ctx.extensions.eden;
    const execution = createExecution({ dryRun });
    const fs = new FilesystemService(execution);

    await fs.mkdir(ctx.values.path);
    await printOperations(execution.operations, { json, dryRun });
  },
});
```
