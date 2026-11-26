import { execFileSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const minimumNodeMajor = 22;
const nodeProbe =
  "JSON.stringify({ name: process.release?.name, version: process.versions.node, bun: process.versions.bun })";
const nodeCandidates = (process.env.PATH ?? "")
  .split(delimiter)
  .filter(Boolean)
  .map((directory) => join(directory, process.platform === "win32" ? "node.exe" : "node"));

const findSupportedNode = () => {
  const seen = new Set();
  for (const candidate of nodeCandidates) {
    try {
      const executable = resolve(candidate);
      if (seen.has(executable)) continue;
      seen.add(executable);
      const result = JSON.parse(
        execFileSync(executable, ["-p", nodeProbe], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      const major = Number(result.version?.split(".")[0]);
      if (result.name === "node" && result.bun === undefined && major >= minimumNodeMajor) {
        return executable;
      }
    } catch {}
  }
  return undefined;
};

const node = findSupportedNode();
if (!node) {
  process.stderr.write(
    "Fallow analysis requires Node.js 22 or later on PATH; install Node.js and retry `bun run check`.\n",
  );
  process.exit(1);
}

const env = {
  ...process.env,
  NODE: node,
  PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}`,
};
const fallow = join(root, "node_modules", "fallow", "bin", "fallow");
execFileSync(node, [fallow, ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit" });
