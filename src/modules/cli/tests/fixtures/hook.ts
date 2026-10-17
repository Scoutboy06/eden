#!/usr/bin/env bun
import { basename } from "node:path";

const input = JSON.parse(await Bun.stdin.text());
const pre = basename(process.argv[1]!).endsWith(".pre");

process.stderr.write(pre ? "pre diagnostic\n" : "post diagnostic\n");
if (pre) {
  process.stdout.write(process.env.EDEN_TEST_PRE_OUTPUT ?? "{}");
  process.exit(Number(process.env.EDEN_TEST_PRE_EXIT ?? 0));
} else {
  process.stdout.write(
    process.env.EDEN_TEST_POST_OUTPUT ?? JSON.stringify({ cwd: process.cwd(), input }),
  );
  process.exit(Number(process.env.EDEN_TEST_POST_EXIT ?? 0));
}
