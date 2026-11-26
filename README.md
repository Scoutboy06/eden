# Eden

## Dependencies

- [Bun](https://bun.sh) is required.
- Node.js 22 or later is required for Fallow analysis during `bun run check`.
- [herdr-core](https://herdr.dev/core/) (`hc` 0.1.22 or later) must be on the Eden server's `PATH` for the default Doing terminal backend.
- Sandbox commands require Docker's standalone `sbx` CLI, signed in and configured with a network policy.

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
bun run test:opencode-e2e
```

The OpenCode conversation E2E suite requires Chromium (`bunx playwright install chromium`).
It runs Eden with isolated HOME/XDG state and a scratch Git project, using only a
test-owned fake OpenCode service on loopback. It also verifies the Doing diff
viewer against staged, unstaged, untracked, binary, large, renamed, and unusual-name
files in that scratch repository. It owns a random-port Vite process and does not
contact installed OpenCode services or real models.

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

Eden rediscovers live worktree terminals from its private `eden-web` core session
after a restart. Closing a terminal tab ends the process; restarting Eden does not.
herdr-core may save terminal screens in its private state directory. Eden sends
the current screen, not old scrollback, on attach. The open pane keeps recent
output locally for mouse scrolling.

Set `EDEN_TERMINAL_BACKEND=bun` to use Bun's native PTY instead. Those sessions end
when Eden shuts down and cannot be restored.

See [CODE.md](CODE.md) for contribution rules.
