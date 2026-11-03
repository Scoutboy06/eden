import { fileURLToPath } from "node:url";
import { discoverTests, partitionTests } from "./test-groups";

const [group = "full", repeats = "2"] = process.argv.slice(2);
if (group !== "fast" && group !== "integration" && group !== "full") {
  throw new Error(`Unknown test group: ${group}`);
}
const runs = Number(repeats);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("Runs must be a positive integer");

const root = new URL("../", import.meta.url);
const files = partitionTests(await discoverTests(root))[group];
const samples: { file: string; wallMs: number[] }[] = files.map((file) => ({ file, wallMs: [] }));

for (let run = 0; run < runs; run++) {
  for (const sample of samples) {
    const start = performance.now();
    const child = Bun.spawn([process.execPath, "test", `./${sample.file}`], {
      cwd: fileURLToPath(root),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    sample.wallMs.push(Math.round((performance.now() - start) * 100) / 100);
    if (exitCode !== 0) {
      console.error(sample.file, stdout, stderr);
      process.exit(exitCode);
    }
  }
}

console.log(
  JSON.stringify(
    {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      group,
      runs,
      samples: samples.sort((left, right) => Math.max(...right.wallMs) - Math.max(...left.wallMs)),
    },
    null,
    2,
  ),
);
