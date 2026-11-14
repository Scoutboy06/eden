#!/usr/bin/env bun

const args = process.argv.slice(2);

await Bun.write(process.env.EDEN_SBX_TRANSFER_ARGS!, JSON.stringify(args));

if (args.includes("-i")) await Bun.write(Bun.stdout, Bun.stdin);
else await Bun.write(Bun.stdout, Buffer.from([0x0d, 0x0a, 0x00, 0xff, 0x1a]));

process.stderr.write("transfer warning");
process.exitCode = Number(process.env.EDEN_SBX_TRANSFER_EXIT ?? 0);
