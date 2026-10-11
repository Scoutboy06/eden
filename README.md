# Eden

## Folder structure

```
src/
  external/     # Adapters and integrations with third-party systems
  modules/      # Reusable Eden features, services, and their command definitions
apps/
  cli/          # The Eden CLI
  web/          # (future) web control plane
```

## Local Development

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run cli --help
bun run cli mkdir ./example --dry-run --json
```

## Adding commands

See the [command creation skill](.agents/skills/eden-command/SKILL.md) for the
workflow and an example. Commands use Eden's CLI module; Gunshi integration
stays inside that module. Add option functionality when a real command needs it.

### Checks

```bash
bun run lint      # Oxlint
bun run fmt       # Oxfmt
bun run fmt:check # Check formatting
bun run analyze   # Fallow code analysis
bun run check     # Run all checks
```
