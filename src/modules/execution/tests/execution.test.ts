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

test.each([false, true])("execution owns the outcome and dry-run state (%s)", async (dryRun) => {
  const execution = createExecution({ dryRun });
  const operation = { type: "example", description: "Example mutation", input: {} };
  const mutation = mock(async () => {});

  const result = await execution.run(async () => {
    await execution.mutate(operation, mutation);
    return { value: 42 };
  });

  expect(result).toEqual({ ok: true, dryRun, data: { value: 42 } });
  expect(execution.operations).toEqual([operation]);
  expect(mutation).toHaveBeenCalledTimes(dryRun ? 0 : 1);
});

test("execution catches a failed mutation and prevents subsequent work", async () => {
  const execution = createExecution({ dryRun: false });
  const failure = new Error("Mutation failed");
  const next = mock(async () => {});

  const result = await execution.run(async () => {
    await execution.mutate(
      { type: "example", description: "Example mutation", input: {} },
      async () => {
        throw failure;
      },
    );
    await next();
  });

  expect(result).toEqual({ ok: false, dryRun: false, error: failure });
  expect(next).not.toHaveBeenCalled();
  expect(execution.operations).toHaveLength(1);
});
