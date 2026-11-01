#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.EDEN_TEMPLATE_LOG!, `${JSON.stringify(["docker", ...args])}\n`);
const digest = process.env.EDEN_TEMPLATE_DIGEST!;
const imageId = process.env.EDEN_TEMPLATE_IMAGE_ID!;
if (args[0] === "buildx") process.stdout.write(JSON.stringify({ digest }));
else if (args[0] === "image" && args[1] === "pull") process.stdout.write("pulled\n");
else if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === "{{json .RepoDigests}}")
  process.stdout.write(
    JSON.stringify([
      `registry.example/team/image@${process.env.EDEN_TEMPLATE_WRONG_DIGEST ?? digest}`,
    ]),
  );
else if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === "{{json .Id}}")
  process.stdout.write(JSON.stringify(imageId));
else if (args[0] === "image" && args[1] === "tag") process.stdout.write("");
else if (args[0] === "image" && args[1] === "save")
  await Bun.write(args[args.indexOf("--output") + 1]!, "example archive");
else {
  process.stderr.write("unexpected docker command");
  process.exitCode = 1;
}
