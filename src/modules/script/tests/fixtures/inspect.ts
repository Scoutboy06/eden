#!/usr/bin/env -S bun run
const input = await Bun.stdin.text();

console.log(
  JSON.stringify({
    input,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    value: process.env.EDEN_SCRIPT_TEST,
    path: process.env.PATH,
  }),
);
