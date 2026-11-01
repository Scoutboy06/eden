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

Profile kit paths beginning with `~/` or `~\` expand from the home directory.
Explicit `./` and `../` kit paths resolve from the current directory; other kit
references pass through unchanged. Profiles may set `pull` (`always`, `missing`,
or `never`) and `disk.root` / `disk.docker` sizes for sandbox creation.

Profiles may define named `mounts` with `path` and optional `readonly: true`. They
are additional direct mounts and require a clone or host workspace; otherwise
Docker Sandboxes would treat the first mount as the primary workspace. Mount paths
must already exist. Writable mounts carry the same host-file risk as host mode.
On Windows, named mounts require drive-letter paths; UNC mount paths are not yet
supported.

Workspace and mount paths and string kit arguments support `${{ sandbox.name }}`,
`${{ workspace.mode }}`, `${{ workspace.path }}`, and named mount expressions such
as `${{ mounts.packages.hostPath }}` and `${{ mounts.packages.sandboxPath }}`.
Unrecognized, unavailable, or cyclic expressions fail before sandbox creation.

Use `eden profile list` and `eden profile show <name>` to inspect effective
sandbox profiles and configuration sources. Profile `mcp_servers` entries pass
through to Docker Sandboxes as static MCP server names.

Sandbox lifecycle hooks run on the host from the Eden hooks directory. Create
runs `sandbox.create.pre` after preflight and `sandbox.create.post` after creation;
pre hooks must return empty output or `{}`.

`eden sbx rm --name <name>` asks Docker Sandboxes for confirmation. Removal
requires `--force` in noninteractive or JSON mode and for running or
unknown-status sandboxes.

### Shell completion

Generate completions with `eden completion <shell>` for `zsh`, `bash`, or `pwsh`. In
PowerShell, load them for the current session with:

```powershell
eden completion pwsh | Out-String | Invoke-Expression
```

To load them in every session, add that line to your `$PROFILE`.

## Development

See [CODE.md](CODE.md) for coding standards.
