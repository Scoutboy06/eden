#!/usr/bin/env bun
if (process.env.EDEN_TEST_CHILD === "1") {
  await Bun.sleep(60_000);
  process.exit(0);
}

const child = Bun.spawn([process.execPath, process.argv[1]!], {
  env: { ...process.env, EDEN_TEST_CHILD: "1" },
  stdout: "ignore",
  stderr: "ignore",
});

process.on("SIGTERM", () => {
  process.stderr.write("cleanup\n");
  process.exit(0);
});
process.stderr.write(`ready:${process.pid}:${child.pid}\n`);
await Bun.write(process.env.EDEN_TEST_READY!, "ready");
setInterval(() => {}, 1000);
