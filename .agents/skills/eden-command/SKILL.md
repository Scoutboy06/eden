---
name: eden-command
description: Guides creation of typed Eden CLI commands. Use when adding or changing command definitions or registering CLI commands.
---

# Creating an Eden command

- Follow `apps/cli/src/commands/mkdir.ts` as the reference example.
- Use `defineCommand` from `src/modules/cli` and register commands through `runCli` in `apps/cli/src/main.ts`.
- Keep presentation in commands and reusable behavior in `src/modules/`.
