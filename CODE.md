# Code

## Structure

- Keep vendor SDK construction, API calls and response normalization in
  `src/external/`; application modules own workflow policy and provider selection.
- Add new vendor SDKs to the import restrictions in `.oxlintrc.json`.
- Commit completed, verified work frequently in small, coherent commits, usually
  one per ticket. Follow the user's commit and publishing instructions.
- Commit each ticket before starting the next; do not accumulate an entire
  horizon in the working tree.

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

## Change summaries and pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Apply these guidelines to PR descriptions and completion messages for meaningful
  code changes, whether or not a PR is opened.
- Conventional commit titles, plain language:
  `fix(cli): task listing no longer drops closed tasks`.
- Body: the problem in a sentence or two, then how you fixed it.
  Explain what the developer can now do and include the command or entry point
  needed to try it.
- Show concrete evidence of the changed behavior:
  - UI changes need clear before/after images. Motion or timing needs a short video.
  - CLI changes need the command and actual output from a representative run.
  - Performance improvements need before/after measurements under the same
    conditions. Include the workload and measurement method; use a chart when useful.
  - Internal changes need a concise explanation of the benefit and focused
    verification of the behavior that must remain unchanged.
- Describe the focused tests or manual checks you ran and the observed results.
  "Tests pass" alone is insufficient. Distinguish real integrations from simulated
  dependencies, and state anything you could not check.
- Make incomplete behavior and follow-up work explicit. Do not describe scaffolding
  or partially connected functionality as a completed feature.
- Evidence must come from actual runs. Label illustrative examples as illustrative.
  Never invent output, measurements, screenshots, or verification results.
- Upload PR evidence to GitHub. For completion messages, embed or link evidence
  where the developer can inspect it. Never commit PR-only screenshots or assets.
- Keep the description proportional to the change. Explain behavior and important
  decisions, not a file-by-file account of the implementation.
