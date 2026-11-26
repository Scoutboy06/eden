import { expect, test } from "bun:test";
import { collectProcess } from "./collect-process";

test("collects fake CLI process output and exit status", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'process.stdout.write("fake stdout"); process.stderr.write("fake stderr"); process.exitCode = 7',
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  await expect(collectProcess(child)).resolves.toEqual({
    exitCode: 7,
    stdout: "fake stdout",
    stderr: "fake stderr",
  });
});
