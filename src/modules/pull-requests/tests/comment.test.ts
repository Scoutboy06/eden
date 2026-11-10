import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildPullRequestComment } from "../comment-input";
import { PullRequestService } from "../service";
import { createExecution } from "../../execution/execution";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { githubProvider } from "../../../external/github/tests/support/github";
import type { PullRequestProvider } from "../provider";

test("body files preserve multiline UTF-8 contents", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "body.md");
    await Bun.write(path, "Hej världen\n\nDetails\n");

    expect(await buildPullRequestComment({ bodyFile: path, replyTo: "review:56" })).toEqual({
      body: "Hej världen\n\nDetails\n",
      replyTo: "review:56",
    });
  });
});

test.each([
  [{}, "SCM_INVALID_OPTIONS"],
  [{ body: " " }, "SCM_INVALID_OPTIONS"],
  [{ body: "Body", bodyFile: "missing" }, "SCM_INVALID_OPTIONS"],
  [{ bodyFile: "missing" }, "SCM_BODY_FILE_FAILED"],
  [{ body: "Body", replyTo: "56" }, "SCM_INVALID_OPTIONS"],
  [{ body: "Body", replyTo: "review:0" }, "SCM_INVALID_OPTIONS"],
  [{ body: "Body", replyTo: "review:9007199254740992" }, "SCM_INVALID_OPTIONS"],
  [{ body: "Body", replyTo: "issue:56" }, "SCM_UNSUPPORTED_OPERATION"],
] as const)("rejects invalid body or reply input %#", async (input, code) => {
  await expect(buildPullRequestComment(input)).rejects.toMatchObject({ code });
});

test("comment dry-run records body and reply target without SDK requests", async () => {
  const execution = createExecution({ dryRun: true });
  const { provider, calls } = githubProvider(() => {
    throw new Error("No requests expected");
  });
  const service = new PullRequestService(undefined, async () => provider, execution);

  expect(
    await service.comment({
      ref: "https://github.com/acme/app/pull/12",
      body: "Body",
      replyTo: "review:56",
    }),
  ).toBeUndefined();
  expect(calls).toEqual([]);
  expect(execution.operations).toMatchObject([
    {
      type: "github-pr-comment",
      input: { ref: { number: 12 }, body: "Body", replyTo: "review:56" },
    },
  ]);
});

test.each([
  { ref: "", body: "Body" },
  { ref: "https://github.com/acme/app/pull/12", body: " " },
  { ref: "https://github.com/acme/app/pull/12", body: "Body", replyTo: "issue:56" },
  { ref: "https://dev.azure.com/acme/project/_git/app/pullrequest/12", body: "Body" },
])("rejects invalid or unsupported input before provider selection %#", async (input) => {
  let selections = 0;
  const service = new PullRequestService(undefined, async () => {
    selections++;
    throw new Error("No provider expected");
  });

  await expect(service.comment(input)).rejects.toThrow();
  expect(selections).toBe(0);
});

test("rejects missing commenter capability before recording mutation", async () => {
  const execution = createExecution({ dryRun: false });
  const service = new PullRequestService(
    undefined,
    async () => ({}) as PullRequestProvider,
    execution,
  );

  await expect(
    service.comment({ ref: "12", repo: "https://github.com/acme/app", body: "Body" }),
  ).rejects.toMatchObject({ code: "SCM_UNSUPPORTED_OPERATION" });
  expect(execution.operations).toEqual([]);
});
