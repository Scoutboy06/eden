#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.EDEN_TEMPLATE_LOG!, `${JSON.stringify(["sbx", ...args])}\n`);
if (JSON.stringify(args) === JSON.stringify(["template", "ls", "--json"])) {
  const present = await Bun.file(process.env.EDEN_TEMPLATE_STATE!).exists();
  process.stdout.write(
    JSON.stringify(
      present
        ? [
            {
              repository: "registry.example/team/image",
              tag: "latest",
              id: await Bun.file(process.env.EDEN_TEMPLATE_STATE!).text(),
            },
          ]
        : [],
    ),
  );
} else if (JSON.stringify(args) === JSON.stringify(["ls", "--json"])) {
  process.stdout.write(process.env.EDEN_TEMPLATE_SANDBOXES ?? "[]");
} else if (args[0] === "inspect") {
  const data = JSON.parse(process.env.EDEN_TEMPLATE_INSPECT ?? "{}")[args.at(-1)!];
  if (!data) {
    process.stderr.write("inspect unavailable");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(data));
} else if (args[0] === "template" && args[1] === "load") {
  if (process.env.EDEN_TEMPLATE_LOAD_FAIL) {
    process.stderr.write("load failed");
    process.exit(1);
  }
  await Bun.write(
    process.env.EDEN_TEMPLATE_STATE!,
    (process.env.EDEN_TEMPLATE_SBX_IMAGE_ID ?? process.env.EDEN_TEMPLATE_IMAGE_ID!).slice(7, 19),
  );
} else {
  process.stderr.write("unexpected sbx command");
  process.exitCode = 1;
}
