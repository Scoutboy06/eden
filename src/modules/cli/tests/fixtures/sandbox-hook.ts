#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
import { basename } from "node:path";

const name = basename(process.argv[1]!);
const input = JSON.parse(await Bun.stdin.text());
await appendFile(process.env.EDEN_SBX_RUN_LOG!, `${JSON.stringify({ hook: name, input })}\n`);
if (process.env.EDEN_HOOK_READY) {
  await Bun.write(process.env.EDEN_HOOK_READY, "ready");
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(`diagnostic from ${name}\n`);
  process.stdout.write(process.env.EDEN_HOOK_OUTPUT ?? "");
  process.exitCode = Number(process.env.EDEN_HOOK_EXIT ?? 0);
}
