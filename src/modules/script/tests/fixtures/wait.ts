#!/usr/bin/env -S bun run
console.log("ready");
if (process.env.EDEN_READY_FILE) await Bun.write(process.env.EDEN_READY_FILE, String(process.pid));

await Bun.sleep(60_000);
