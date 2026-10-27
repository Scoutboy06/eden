#!/usr/bin/env bun

const args = process.argv.slice(2);
const mode = process.env.EDEN_SBX_RUN_MODE;
const name = process.env.EDEN_SBX_RUN_NAME ?? "example";
const log = process.env.EDEN_SBX_RUN_LOG;

if (log) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(log, `${JSON.stringify(args)}\n`);
}

if (JSON.stringify(args) === JSON.stringify(["ls", "--format", "json"])) {
  process.stdout.write(
    mode === "malformed"
      ? "invalid json"
      : JSON.stringify(mode === "missing" ? [] : [{ name, status: mode ?? "running" }]),
  );
} else if (JSON.stringify(args) === JSON.stringify(["run", "--name", name])) {
  if (mode === "interrupt" || mode === "ignore" || mode === "terminal") {
    if (mode === "terminal") process.stdin.setRawMode(true);
    process.on("SIGINT", () => {
      if (mode !== "ignore") process.exit(130);
    });
    await Bun.write(process.env.EDEN_SBX_RUN_READY!, String(process.pid));
    setInterval(() => {}, 1000);
  } else if (mode === "stdin") {
    process.stdout.write(`input:${await Bun.stdin.text()}`);
  } else {
    process.stdout.write("attached\n");
    process.stderr.write("provider stderr\n");
    process.exitCode = mode === "failure" ? 7 : 0;
  }
} else {
  process.stderr.write(`Unexpected provider command: ${JSON.stringify(args)}\n`);
  process.exitCode = 99;
}
