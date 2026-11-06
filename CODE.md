# Code

## Structure

- Keep vendor SDK construction, API calls and response normalization in
  `src/external/`; application modules own workflow policy and provider selection.
- Add new vendor SDKs to the import restrictions in `.oxlintrc.json`.
- Discover tasks with `bun run tasks --ready`; fetch details with `bd show <id>` only for selected tasks.
- Use `bun run tasks --limit 0` for the compact open-task catalog. For a full audit, redirect `bd list --all --limit 0 --json` to a file rather than loading it into agent context.

## Style

- Do not write code comments; express intent through names and structure.
- Separate logical blocks with one blank line, including test setup, action and assertions.
- Order files as imports, supporting types, primary function or class, then helpers.

## Testing

- Before adding a test, identify the mistake it catches and check for existing coverage.
- Keep detailed matrices in service or adapter tests; retain representative CLI
  cases for wiring, presentation and real process behavior.
- Register real-process suites in the integration group in `scripts/test-groups.ts`.
- Integration tests require Git and Bun on PATH; shell tests require their shell.
  Report platform/tool-dependent skips with reasons; missing dependencies are not regressions.

## Documentation

- Keep sections fixed and bullets short. Omit redundant information.
- README: prerequisites and Install/Develop commands. AGENTS: links to guidance.
