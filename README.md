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
be existing directories. Host mode mounts the folder
writable, allowing changes to hooks, Git configuration, and build output that may
later run on the host. With no workspace setting, no host folder is mounted.

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
pre hooks must return empty output or `{}`. `eden sbx rm --name <name>` runs
`sandbox.remove.pre` and asks Docker Sandboxes for confirmation. Removal requires
`--force` in noninteractive or JSON mode and for running or unknown-status
sandboxes; force skips the pre-removal hook and provider confirmation.

Interactive, non-JSON sandbox creation gives Docker Sandboxes the terminal for
kit credential approval. In unattended creation, Docker may create a sandbox
without an unapproved credential. Eden reports recognized missing-binding
warnings, but provider diagnostics do not guarantee detection of every case.

`eden profile update-template <name>` compares the profile template with its
registry, pulls and verifies a changed image, and loads it into Docker Sandboxes.
It requires Docker, Buildx, a reachable Docker daemon, and Docker registry
credentials. It also updates the matching image tag in the host Docker daemon.
Existing sandboxes are left intact; Eden inspects their image metadata to report
outdated matches and identifies cases it could not attribute or inspect.

### Pull requests

Read pull requests on github.com and Azure DevOps Services:

```sh
eden pr show https://github.com/owner/repo/pull/123 --comments --checks
eden pr show 123 --repo https://github.com/owner/repo --raw --json
eden pr checks --required-only --watch --interval 10 --timeout 600
```

Omit the PR reference to discover the open PR for the current branch. Use `--head`
to select another source branch, and `--repo` or `--remote` to select a repository.
Ambiguous repositories or PR matches require explicit selection.

`show --raw` adds the provider's PR response; `--comments` adds discussion and
inline comments, and `--checks` adds CI results. These fields are omitted unless
requested. Azure comments retain thread resolution; GitHub's REST comments do not
provide resolution state.

`checks --required-only` reads classic branch protection and active rulesets on
GitHub, and enabled, blocking build/status policies on Azure. It does not report
reviewer or other merge policies. Missing required GitHub checks remain pending.
GitHub requires access to branch rules; permission errors and required workflow
rules that cannot be represented as named checks fail explicitly.

`checks --watch` polls every 10 seconds for up to 600 seconds by default. Interval
and timeout are positive seconds and require `--watch`. It emits one final result,
including in JSON mode. Passed/skipped checks and an empty check list succeed;
failed/cancelled checks, unknown states, timeouts and provider errors fail with
exit code 1. Ctrl-C or SIGTERM cancels with exit code 130. Without `--watch`, check
states are returned as data without making failed CI a command failure.

GitHub authentication uses `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh`; Azure uses
`AZURE_DEVOPS_EXT_PAT`, then an Entra token from `az login`. Eden does not log in or
store credentials. These reads still run under `--dry-run`. As with other Eden
commands, `--json` emits structured success or error output on stdout; human
errors go to stderr.

### Shell completion

Generate completions with `eden completion <shell>` for `zsh`, `bash`, or `pwsh`. In
PowerShell, load them for the current session with:

```powershell
eden completion pwsh | Out-String | Invoke-Expression
```

To load them in every session, add that line to your `$PROFILE`.

## Development

See [CODE.md](CODE.md) for coding standards.
