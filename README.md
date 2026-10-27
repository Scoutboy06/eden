# Eden

A CLI for streamlining development workflows with Git worktrees, sandbox creation,
configuration, and hooks.

## Get started

Requires [Bun](https://bun.sh). Sandbox creation also requires Docker's standalone
`sbx` CLI, signed in and configured with a network policy.

```sh
bun install
bun run cli --help
bun run cli setup

bun run cli worktree create --name fix-login
bun run cli sbx create --provider docker-sbx --name eden-dev
bun run cli sbx run --provider docker-sbx --name eden-dev
bun run cli sbx list --provider docker-sbx
bun run cli sbx stop --provider docker-sbx --name eden-dev
```

Use `--dry-run` to preview changes and `--json` for scripting. Sandbox previews
also check provider readiness. `sbx run` creates the named sandbox if absent,
starts it if stopped, and attaches. Use `--image` only when creating a new sandbox;
omitting it uses the provider default. An existing sandbox rejects `--image`
because its image cannot be verified. Interactive attachment does not support
`--json`; use `--dry-run --json` to preview it.

`sbx stop --name <name>` stops an existing sandbox without removing it or its
data. Already-stopped sandboxes succeed without another stop request; missing
sandboxes fail. Use `sbx run` to restart and attach later. Stop previews list
sandboxes but never send a stop request.

## Make it yours

Global settings live in `~/.config/eden/config.yaml` (or `$XDG_CONFIG_HOME/eden/config.yaml`).

```sh
bun run cli config set worktree_root '~/.worktrees'
bun run cli config get
```

Explore each command with `--help`.

Enable completions in your current Bash session:

```bash
source <(bun run cli completion bash --stdout)
```

## Development

Code lives in `src/modules/`; CLI commands live in `apps/cli/src/commands/`.
See [CODE.md](CODE.md) for coding standards.

```sh
bun run check
bun test
bunx tsc --noEmit
```
