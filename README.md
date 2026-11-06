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

See [CODE.md](CODE.md) for contribution rules.
