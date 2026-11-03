#!/usr/bin/env bun

const mode = process.env.EDEN_SBX_TEST_MODE;

if (mode === "descendant" && !process.argv.includes("--descendant")) {
  Bun.spawn([process.execPath, import.meta.filename, "--descendant"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(0);
}

process.stdout.write("provider stdout\n");
process.stderr.write("provider stderr\n");

if (mode === "success" || mode === "failure") process.exit(mode === "success" ? 0 : 7);

process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
await Bun.write(process.env.EDEN_SBX_TEST_READY!, String(process.pid));
await Bun.sleep(60_000);
