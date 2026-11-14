#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.EDEN_FRESHNESS_LOG!, `${JSON.stringify(["az", ...args])}\n`);
process.stderr.write("ERROR: Please run 'az login' to setup account.");
process.exit(1);
