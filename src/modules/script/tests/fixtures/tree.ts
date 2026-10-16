#!/usr/bin/env -S bun run
const child = Bun.spawn([process.execPath, "run", `${import.meta.dir}/tree-child.ts`], {
  env: process.env,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});

process.on("SIGTERM", () => process.exit(0));
await child.exited;
