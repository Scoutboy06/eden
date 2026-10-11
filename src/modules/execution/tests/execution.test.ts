import { expect, mock, test } from "bun:test";
import { createExecution } from "../execution";

test("normal execution invokes the mutation callback", async () => {
  const execution = createExecution({ dryRun: false });
  const action = mock(async () => {});

  await execution.mutate({ type: "example", description: "Example mutation", input: {} }, action);

  expect(action).toHaveBeenCalledTimes(1);
});

test("dry-run records the intended operation without invoking its callback", async () => {
  const execution = createExecution({ dryRun: true });
  const operation = { type: "example", description: "Example mutation", input: {} };
  const action = mock(async () => {});

  await execution.mutate(operation, action);

  expect(execution.operations).toEqual([operation]);
  expect(action).not.toHaveBeenCalled();
});

test("mutation failures propagate while retaining the intended operation", async () => {
  const execution = createExecution({ dryRun: false });
  const operation = { type: "example", description: "Example mutation", input: {} };
  const failure = new Error("Mutation failed");

  await expect(
    execution.mutate(operation, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);

  expect(execution.operations).toEqual([operation]);
});
