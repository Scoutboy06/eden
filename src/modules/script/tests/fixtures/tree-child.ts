#!/usr/bin/env -S bun run
if (process.env.EDEN_IGNORE_TERM === "1") process.on("SIGTERM", () => {});

await Bun.write(process.env.EDEN_READY_FILE!, String(process.pid));
await Bun.sleep(60_000);
