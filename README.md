# Eden

## Folder structure

```
src/
  external/     # Adapters and integrations with third-party systems
  modules/      # Reusable Eden features, services, and their command definitions
apps/
  cli/          # The Eden CLI
  web/          # (future) web control plane
```

## Local Development

Read [CODE.md](CODE.md) for project coding standards.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run cli --help
bun run cli mkdir ./example --dry-run --json
bun run cli worktree create --name "Fix login" --dry-run --json
```

### Configuration

Put global configuration in `$XDG_CONFIG_HOME/eden/config.yaml` (default: `~/.config/eden/config.yaml`).

Configuration is optional. Worktrees default to `~/.worktrees/<repository>/<name>`.
Override the root with an absolute path or a path starting with `~/`:

```yaml
worktree_root: ~/.worktrees
```

Inspect effective configuration, including defaults and expanded paths:

```sh
bun run cli config get
bun run cli config get agent
bun run cli config get agent.default
bun run cli config get worktree_root --json
```

Dot-separated keys select a subtree or a single setting. Known but unset settings
produce empty output (`null` in JSON); unknown keys fail. Objects print as YAML,
while individual values print directly. Reading configuration never writes files.

### Hooks

Eden supports optional executable scripts that run before or after an action:

- Pre-hooks run before an action and may modify its parameters or prevent execution.
- Post-hooks run after an action and may inspect its result.

### Completions

```sh
bun run cli completion zsh --stdout
```

### Checks

```bash
bun run lint      # Oxlint
bun run fmt       # Oxfmt
bun run fmt:check # Check formatting
bun run analyze   # Fallow code analysis
bun run check     # Run lint, formatting, and code analysis
bun run test      # Run automated tests
bunx tsc --noEmit # Typecheck
```
