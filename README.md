# Eden

A CLI for streamlining development workflows with Git worktrees, sandbox creation,
configuration, and hooks.

## Get started

Requires [Bun](https://bun.sh). Sandbox creation also requires Docker's standalone
`sbx` CLI, signed in and configured with a network policy.

```sh
bun install
bun run cli --help

bun run cli worktree create --name fix-login
bun run cli sbx create --provider docker-sbx --name eden-dev
```

Use `--dry-run` to preview changes and `--json` for scripting. Sandbox previews
also check provider readiness.

## Make it yours

Global settings live in `~/.config/eden/config.yaml` (or `$XDG_CONFIG_HOME/eden/config.yaml`).

```sh
bun run cli config set worktree_root '~/.worktrees'
bun run cli config get
bun run cli completion zsh --stdout
```

Explore each command with `--help`.

## Development

Code lives in `src/modules/`; CLI commands live in `apps/cli/src/commands/`.
See [CODE.md](CODE.md) for coding standards.

```sh
bun run check
bun test
bunx tsc --noEmit
```
