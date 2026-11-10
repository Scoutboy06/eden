import { expect, test } from "bun:test";
import { PullRequestService } from "../service";
import { createExecution } from "../../execution/execution";
import type { PullRequestProvider } from "../provider";
import { githubProvider } from "../../../external/github/tests/support/github";

test("close dry-run records exact target and comment without HTTP requests", async () => {
  const execution = createExecution({ dryRun: true });
  const { provider, calls } = githubProvider(() => {
    throw new Error("No requests expected");
  });
  const service = new PullRequestService(undefined, async () => provider, execution);

  expect(
    await service.close({ ref: "https://github.com/acme/app/pull/12", comment: "Closing" }),
  ).toBeUndefined();
  expect(calls).toEqual([]);
  expect(execution.operations).toMatchObject([
    {
      type: "github-pr-close",
      input: {
        ref: { provider: "github", owner: "acme", repository: "app", number: 12 },
        comment: "Closing",
      },
    },
  ]);
});

test.each([
  { ref: "https://github.com/acme/app/pull/12", comment: " " },
  { ref: "" },
  { ref: "https://dev.azure.com/acme/project/_git/app/pullrequest/12" },
  { ref: "https://github.com/acme/app/pull/12", repo: "https://github.com/other/repo" },
])("rejects invalid or unsupported close requests before provider selection %#", async (input) => {
  let selections = 0;
  const service = new PullRequestService(undefined, async () => {
    selections++;
    throw new Error("No provider expected");
  });

  await expect(service.close(input)).rejects.toThrow();
  expect(selections).toBe(0);
});

test("rejects providers without close capability before recording a mutation", async () => {
  const execution = createExecution({ dryRun: false });
  const service = new PullRequestService(
    undefined,
    async () => ({}) as PullRequestProvider,
    execution,
  );

  await expect(
    service.close({ ref: "12", repo: "https://github.com/acme/app" }),
  ).rejects.toMatchObject({ code: "SCM_UNSUPPORTED_OPERATION" });
  expect(execution.operations).toEqual([]);
});
