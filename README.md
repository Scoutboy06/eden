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
```

Explore each command with `--help`.

Configuration lives in `$XDG_CONFIG_HOME/eden`, falling back to `~/.config/eden`, on every
platform including Windows. On Windows, `worktree_root` must start with a drive letter
(`C:\`) or a UNC share, and `~\` expands like `~/`.

## Development

See [CODE.md](CODE.md) for coding standards.
