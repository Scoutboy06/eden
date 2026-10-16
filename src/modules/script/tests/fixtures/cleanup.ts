#!/usr/bin/env -S bun run
process.on("SIGTERM", async () => {
  await Bun.sleep(50);
  console.log("cleaned up");
  process.exit(0);
});

await Bun.write(process.env.EDEN_READY_FILE!, String(process.pid));
await Bun.sleep(60_000);
