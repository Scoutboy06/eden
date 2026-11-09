import { expect, test } from "bun:test";
import { buildPullRequestCreate } from "../create-input";
import { PullRequestService } from "../service";
import { createExecution } from "../../execution/execution";
import { githubProvider } from "../../../external/github/tests/support/github";

test("create inputs preserve empty bodies and deduplicate comma-separated metadata", async () => {
  expect(
    await buildPullRequestCreate({
      title: "Title",
      base: "main",
      body: "",
      reviewer: "alice, bob,alice",
      label: "bug, needs review",
    }),
  ).toEqual({
    title: "Title",
    base: "main",
    body: "",
    draft: false,
    reviewers: ["alice", "bob"],
    labels: ["bug", "needs review"],
  });
});

test.each([
  { title: " " },
  { base: " " },
  { body: "", bodyFile: "missing" },
  { bodyFile: "missing" },
  { reviewer: "alice," },
  { label: "" },
])("rejects invalid create input %#", async (override) => {
  await expect(
    buildPullRequestCreate({ title: "Title", base: "main", ...override }),
  ).rejects.toThrow();
});

test("create resolves current branch and dry-run records all metadata without HTTP calls", async () => {
  const { provider, calls } = githubProvider(() => {
    throw new Error("No requests expected");
  });
  const execution = createExecution({ dryRun: true });
  const service = new PullRequestService(
    {
      remotes: async () => [{ name: "origin", url: "git@github.com:acme/app.git" }],
      branch: async () => "topic",
    },
    async () => provider,
    execution,
  );

  await service.createByReference({
    title: "Title",
    body: "",
    base: "main",
    reviewers: ["alice"],
    labels: ["bug"],
  });

  expect(calls).toEqual([]);
  expect(execution.operations).toMatchObject([
    {
      type: "github-pr-create",
      input: { sourceBranch: "topic", targetBranch: "main", reviewers: ["alice"], labels: ["bug"] },
    },
  ]);
});

test("Azure CLI creation is rejected before selecting credentials or a provider", async () => {
  let selections = 0;
  const service = new PullRequestService(undefined, async () => {
    selections++;
    throw new Error("No provider expected");
  });

  await expect(
    service.createByReference({
      repo: "https://dev.azure.com/acme/project/_git/app",
      head: "topic",
      title: "Title",
      body: "",
      base: "main",
    }),
  ).rejects.toMatchObject({ code: "SCM_UNSUPPORTED_OPERATION" });
  expect(selections).toBe(0);
});

test("overlong reviewer logins fail before provider selection or PR creation", async () => {
  let selections = 0;
  const service = new PullRequestService(undefined, async () => {
    selections++;
    throw new Error("No provider expected");
  });

  await expect(
    service.createByReference({
      repo: "https://github.com/acme/app",
      head: "topic",
      title: "Title",
      body: "",
      base: "main",
      reviewers: ["a".repeat(40)],
    }),
  ).rejects.toMatchObject({ code: "SCM_INVALID_REFERENCE" });
  expect(selections).toBe(0);
});
