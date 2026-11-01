#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.EDEN_FRESHNESS_LOG!, `${JSON.stringify(["sbx", ...args])}\n`);
if (JSON.stringify(args) === JSON.stringify(["ls", "--json"]))
  process.stdout.write(process.env.EDEN_FRESHNESS_SANDBOXES ?? "[]");
else if (JSON.stringify(args) === JSON.stringify(["template", "ls", "--json"])) {
  if (process.env.EDEN_FRESHNESS_TEMPLATE_FAILURE) process.exit(1);
  process.stdout.write(process.env.EDEN_FRESHNESS_TEMPLATES ?? "[]");
} else if (args[0] === "inspect") {
  const value = JSON.parse(process.env.EDEN_FRESHNESS_INSPECT ?? "{}")[args.at(-1)!];
  if (!value) {
    process.stderr.write("inspection failed");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(value));
} else {
  process.stderr.write("unexpected sbx command");
  process.exit(1);
}
