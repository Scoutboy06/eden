# Eden development

- Follow [CODE.md](CODE.md) for coding standards, test placement and validation.
- When adding or changing CLI commands, follow the tracked
  [Eden command skill](.agents/skills/eden-command/SKILL.md) and its reference command.
- Keep [README.md](README.md) focused on getting started and user-facing behavior;
  put contributor guidance in `CODE.md` and use command `--help` for CLI details.
- Run `bun run check` and `bun run test:fast` while developing. Run
  `bun run test:full` before merging; see `CODE.md` for prerequisites and skip policy.
