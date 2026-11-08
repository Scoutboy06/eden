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

Configure projects in the global `~/.config/eden/config.yaml` (or
`$XDG_CONFIG_HOME/eden/config.yaml`): `projects: { eden: { name: Eden, path: ~/src/eden } }`.
The mapping key is the stable URL key used at `/p/<key>`; each entry needs a display
`name` and local repository `path`. The root route is the project picker.

See [CODE.md](CODE.md) for contribution rules.
