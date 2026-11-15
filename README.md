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

See [CODE.md](CODE.md) for contribution rules.
