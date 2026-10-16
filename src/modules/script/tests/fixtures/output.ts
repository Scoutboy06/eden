#!/usr/bin/env -S bun run
const size = Number(process.argv[2] ?? 1);

await Promise.all([
  Bun.write(Bun.stdout, "out\n".repeat(size)),
  Bun.write(Bun.stderr, "err\n".repeat(size)),
]);
process.exit(Number(process.argv[3] ?? 0));
