#!/usr/bin/env bun

const args = process.argv.slice(2);

if (
  JSON.stringify(args) === JSON.stringify(["ls", "--format", "json"]) ||
  JSON.stringify(args) === JSON.stringify(["policy", "ls", "--json"])
) {
  process.stdout.write("[]\n");
} else {
  process.stderr.write(`Unexpected sandbox command: ${args.join(" ")}\n`);
  process.exitCode = 1;
}
