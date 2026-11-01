#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.EDEN_FRESHNESS_LOG!, `${JSON.stringify(["docker", ...args])}\n`);
if (args[0] !== "buildx" || args[1] !== "imagetools" || args[2] !== "inspect") process.exit(2);
const digest = JSON.parse(process.env.EDEN_FRESHNESS_DIGESTS ?? "{}")[args[3]!];
if (!digest) {
  process.stderr.write("authentication failed");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ digest }));
