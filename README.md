# Eden

Requires [Bun](https://bun.sh). Sandbox commands also require Docker's standalone
`sbx` CLI, signed in and configured with a network policy.

## Install

```sh
bun install
bun link
eden setup
```

## Develop

```sh
bun run web:dev
bun run check
bun run test:fast
bun run test:full
```

The task board reads each configured repository's existing Beads (`bd`) configuration.
Install `bd` and verify `bd list` first. Task data requires the Vite dev or preview server.

Projects are stored in a host-local SQLite registry under `$XDG_STATE_HOME/eden`
(or `~/.local/state/eden`). On first use, Eden imports the legacy global `projects`
mapping from `~/.config/eden/config.yaml` (or `$XDG_CONFIG_HOME/eden/config.yaml`)
once; the YAML file remains unchanged. Use `eden project list` to inspect registrations
and import or remove projects from the web project picker. Project keys remain the
stable URL keys used at `/p/<key>`; the root route is the project picker.

The Doing page can start shared host-shell terminals in registered Git worktrees.
Terminals are available to anyone who can reach the Eden server and grant the same
permissions as the Eden OS user. There is no separate terminal login or sandbox.
The web server binds to `127.0.0.1` by default. For a private Tailscale deployment,
bind explicitly to this machine's Tailscale IP with `EDEN_WEB_HOST=100.x.y.z bun run web:dev`.
Only loopback and Tailscale addresses are accepted; do not expose Eden on a LAN or
public interface. Browser requests require a matching origin and host.

Terminals use Bun's native PTY (POSIX PTY/Windows ConPTY), live in memory only, and
end when Eden restarts or a user explicitly ends the session. Only the current
screen is shared; scrollback and transcripts are not saved. Linux PTY behavior is
covered by integration tests; Windows compatibility is implemented but not tested.

See [CODE.md](CODE.md) for contribution rules.
