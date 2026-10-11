---
name: eden-command
description: Guides creation of typed Eden CLI commands. Use when adding or changing command definitions or registering CLI commands.
---

# Creating an Eden command

- Read `apps/cli/src/commands/mkdir.ts` as the reference example.
- Define commands in `apps/cli/src/commands/` using `defineCommand` from
  `src/modules/cli`, not Gunshi directly.
- Register commands in `apps/cli/src/main.ts` through `runCli`.
- Keep CLI presentation in commands and reusable behavior in `src/modules/`.
- Add arguments and option behavior only when the command needs them.
- For mutations and dry-run handling, follow the live example from
  `apps/cli/src/commands/mkdir.ts` through `src/modules/fs/fs.service.ts` and
  `src/modules/execution/execution.ts`.
