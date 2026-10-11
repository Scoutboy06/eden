import { lazy } from "gunshi";
import { defineCommand } from "../../command";
import { writeOutput } from "../../output";

export const echo = defineCommand({
  name: "echo",
  args: { value: { type: "positional", required: true } },
  run(ctx) {
    const { json, dryRun } = ctx.extensions.eden;
    return writeOutput(
      { json, destination: "stdout" },
      { data: { value: ctx.values.value, dryRun }, human: () => ctx.values.value },
    );
  },
});

export const twoRequiredOptions = defineCommand({
  name: "two-required-options",
  args: {
    first: { type: "string", required: true },
    second: { type: "string", required: true },
  },
  run() {
    throw new Error("Validation should prevent execution");
  },
});

export const uncodedFailure = defineCommand({
  name: "uncoded-failure",
  run() {
    throw new Error("Something failed");
  },
});

export const codedFailure = defineCommand({
  name: "coded-failure",
  run() {
    throw Object.assign(new Error("Access denied"), { code: "EACCES" });
  },
});

export const emptyAggregate = defineCommand({
  name: "empty-aggregate",
  run() {
    throw new AggregateError([], "Empty aggregate");
  },
});

export const singleAggregate = defineCommand({
  name: "single-aggregate",
  run() {
    throw new AggregateError([Object.assign(new Error("Access denied"), { code: "EACCES" })]);
  },
});

export const loadingFailure = lazy(() => {
  throw new Error("Loading failed");
});
