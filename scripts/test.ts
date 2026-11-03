import { discoverTests, partitionTests } from "./test-groups";
import { fileURLToPath } from "node:url";

const [group = "full", ...args] = process.argv.slice(2);
if (group !== "fast" && group !== "integration" && group !== "full") {
  throw new Error(`Unknown test group: ${group}`);
}

const root = new URL("../", import.meta.url);
const groups = partitionTests(await discoverTests(root));
const files = groups[group];
if (files.length === 0) throw new Error(`No tests found for ${group}`);

if (args.length === 1 && args[0] === "--list") {
  console.log(files.join("\n"));
} else {
  const child = Bun.spawn(
    [process.execPath, "test", ...files.map((file) => `./${file}`), ...args],
    {
      cwd: fileURLToPath(root),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  process.exitCode = await child.exited;
}
