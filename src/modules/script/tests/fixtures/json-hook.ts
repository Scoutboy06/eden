#!/usr/bin/env -S bun run
const input = await Bun.stdin.json();

console.log(JSON.stringify({ success: true, message: `Hello ${input.name}` }));
