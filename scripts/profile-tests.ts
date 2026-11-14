import { fileURLToPath } from "node:url";
import { discoverTests, partitionTests } from "./test-groups";

const [group = "full", repeats = "2"] = process.argv.slice(2);
if (group !== "fast" && group !== "integration" && group !== "full") {
  throw new Error(`Unknown test group: ${group}`);
}
const runs = Number(repeats);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("Runs must be a positive integer");

const root = new URL("../", import.meta.url);
const discoveredTests = await discoverTests(root);
const groups = partitionTests(discoveredTests);
const files = groups[group];
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
    const elapsedMs = performance.now() - start;
    const roundedElapsedMs = Math.round(elapsedMs * 100) / 100;
    sample.wallMs.push(roundedElapsedMs);
    if (exitCode !== 0) {
      console.error(sample.file, stdout, stderr);
      process.exit(exitCode);
    }
  }
}

samples.sort((left, right) => {
  const leftSlowestRun = Math.max(...left.wallMs);
  const rightSlowestRun = Math.max(...right.wallMs);

  return rightSlowestRun - leftSlowestRun;
});

const report = {
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  group,
  runs,
  samples,
};

console.log(JSON.stringify(report, null, 2));
