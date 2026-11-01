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

To get an `eden` command on your `PATH` (including on Windows, where `bun link` creates
an `eden.exe` shim in `~/.bun/bin`), run `bun link` in the checkout. Remove it again with
`bun unlink`.

Explore each command with `--help`.

Configuration lives in `$XDG_CONFIG_HOME/eden`, falling back to `~/.config/eden`, on every
platform including Windows. On Windows, `worktree_root` must start with a drive letter
(`C:\`) or a UNC share, and `~\` expands like `~/`.

Sandbox profiles can select an agent, for example:

```sh
eden config set sandbox.profiles.work.agent claude
```

Docker Sandboxes supports `claude`, `codex`, and `opencode` here. An unset profile
agent uses `shell`; the global `agent.default` does not change this choice.

A profile can set `workspace.mode` to `none`, `clone`, or `host`. Clone and host
use `--path` when supplied, otherwise `workspace.path`, otherwise the current
repository root. Relative paths resolve from the current directory and paths must
be existing directories. Host mode mounts the folder writable, allowing changes
to hooks, Git configuration, and build output that may later run on the host.
With no workspace setting, no host folder is mounted.

Profiles may set `pull` (`always`, `missing`, or `never`) and `disk.root` /
`disk.docker` sizes for sandbox creation.

### Shell completion

Generate completions with `eden completion <shell>` for `zsh`, `bash`, or `pwsh`. In
PowerShell, load them for the current session with:

```powershell
eden completion pwsh | Out-String | Invoke-Expression
```

To load them in every session, add that line to your `$PROFILE`.

## Development

See [CODE.md](CODE.md) for coding standards.
