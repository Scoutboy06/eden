import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { printOperations, writeOutput } from "../output";

afterEach(() => mock.restore());

test("writes compact JSON to stdout without evaluating human presentation", async () => {
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
  await writeOutput(
    { json: true, destination: "stdout" },
    {
      data: { value: 42 },
      human: () => {
        throw new Error("Human presentation must stay lazy");
      },
    },
  );
  expect(stdout).toHaveBeenCalledWith('{"value":42}\n');
  expect(stderr).not.toHaveBeenCalled();
});

test("writes asynchronous human presentation only to stderr", async () => {
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
  await writeOutput(
    { json: false, destination: "stderr" },
    { data: { unused: true }, human: async () => "Human message" },
  );
  expect(stderr).toHaveBeenCalledWith("Human message\n");
  expect(stdout).not.toHaveBeenCalled();
});

test("preserves human operation lines", async () => {
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  await printOperations(
    [
      { type: "fs.mkdir", description: "Create first", input: { path: "first" } },
      { type: "fs.mkdir", description: "Create second", input: { path: "second" } },
    ],
    { json: false, dryRun: true },
  );
  expect(stdout).toHaveBeenCalledWith("[dry-run] Create first\n[dry-run] Create second\n");
});

test("does not print a blank line for an empty human operation list", async () => {
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  await printOperations([], { json: false, dryRun: false });
  expect(stdout).not.toHaveBeenCalled();
});
