import { expect, mock, test } from "bun:test";
import { printOperations, writeOutput } from "../output";
import { captureOutput } from "./support/output";

test("JSON presentation is written as one compact object on stdout", async () => {
  const result = await captureOutput(() =>
    writeOutput(
      { json: true, destination: "stdout" },
      { data: { value: 42 }, human: () => "unused" },
    ),
  );

  expect(result).toEqual({ stdout: '{"value":42}\n', stderr: "" });
});

test("JSON mode does not evaluate the human renderer", async () => {
  const human = mock(() => "unused");

  await captureOutput(() =>
    writeOutput({ json: true, destination: "stdout" }, { data: {}, human }),
  );

  expect(human).not.toHaveBeenCalled();
});

test("asynchronous human presentation is written only to stderr", async () => {
  const result = await captureOutput(() =>
    writeOutput(
      { json: false, destination: "stderr" },
      { data: {}, human: async () => "Human message" },
    ),
  );

  expect(result).toEqual({ stdout: "", stderr: "Human message\n" });
});

test("human operation output preserves order and marks dry-run", async () => {
  const result = await captureOutput(() =>
    printOperations(
      [
        { type: "fs.mkdir", description: "Create first", input: { path: "first" } },
        { type: "fs.mkdir", description: "Create second", input: { path: "second" } },
      ],
      { json: false, ok: true, dryRun: true },
    ),
  );

  expect(result).toEqual({
    stdout: "[dry-run] Create first\n[dry-run] Create second\n",
    stderr: "",
  });
});

test("empty human operation lists produce no output", async () => {
  const result = await captureOutput(() =>
    printOperations([], { json: false, ok: true, dryRun: false }),
  );

  expect(result).toEqual({ stdout: "", stderr: "" });
});

test("JSON operation output identifies success", async () => {
  const result = await captureOutput(() =>
    printOperations([], { json: true, ok: true, dryRun: false }),
  );

  expect(JSON.parse(result.stdout)).toEqual({ ok: true, dryRun: false, operations: [] });
  expect(result.stderr).toBe("");
});
