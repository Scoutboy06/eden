import { expect, mock, test } from "bun:test";
import { CommentThreadStatus, CommentType } from "azure-devops-node-api/interfaces/GitInterfaces";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import { azureProvider } from "./support/azure";
import type { AzureGitClient } from "../provider";

const ref: PullRequestRef = {
  provider: "azure-devops",
  organizationUrl: "https://dev.azure.com/acme",
  id: 42,
};

test("Azure thread listing uses the latest diff for tracking while preserving original positions", async () => {
  const getPullRequestIterations = mock<AzureGitClient["getPullRequestIterations"]>(async () => [
    { id: 1 },
    { id: 2 },
  ]);
  const getThreads = mock<AzureGitClient["getThreads"]>(
    async (_repository, _id, _project, iteration) => [
      {
        id: 11,
        status: CommentThreadStatus.Pending,
        comments: [
          {
            id: 1,
            content: "Please update",
            commentType: CommentType.Text,
            publishedDate: new Date("2026-11-18T00:00:00Z"),
          },
          {
            id: 2,
            parentCommentId: 1,
            content: "Reply",
            commentType: CommentType.Text,
            publishedDate: new Date("2026-11-18T01:00:00Z"),
          },
        ],
        threadContext: {
          filePath: iteration ? "/src/new.ts" : "/src/old.ts",
          leftFileStart: { line: 3, offset: 1 },
          leftFileEnd: { line: 4, offset: 2 },
          rightFileStart: { line: iteration ? 5 : 2, offset: 1 },
          rightFileEnd: { line: iteration ? 6 : 3, offset: 2 },
        },
        pullRequestThreadContext: {
          changeTrackingId: 7,
          iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
          trackingCriteria: {
            firstComparingIteration: 1,
            secondComparingIteration: iteration ?? 1,
            origFilePath: "/src/original.ts",
            origRightFileStart: { line: 2, offset: 1 },
            origLeftFileStart: { line: 1, offset: 1 },
          },
        },
      },
      {
        id: 12,
        status: CommentThreadStatus.Fixed,
        comments: [
          {
            id: 2,
            content: "Resolved",
            commentType: CommentType.Text,
            publishedDate: new Date("2026-11-19T00:00:00Z"),
          },
        ],
      },
      {
        id: 13,
        status: CommentThreadStatus.Active,
        comments: [
          {
            id: 3,
            content: "Untracked",
            commentType: CommentType.Text,
            publishedDate: new Date("2026-11-18T00:00:00Z"),
          },
        ],
        threadContext: { filePath: "/src/stale.ts", rightFileStart: { line: 90 } },
      },
    ],
  );
  const provider = azureProvider({ getPullRequestIterations, getThreads });

  const result = await provider.listCommentThreads(ref, {
    unresolved: true,
    since: "2026-11-18T00:00:00Z",
    limit: 10,
  });

  expect(result.threads).toHaveLength(2);
  expect(result.threads[0]?.[0]).toMatchObject({
    id: "11:1",
    isResolved: false,
    path: "/src/new.ts",
    line: 5,
    location: {
      tracked: {
        path: "/src/new.ts",
        right: { start: { line: 5, offset: 1 }, end: { line: 6, offset: 2 } },
      },
      original: {
        path: "/src/original.ts",
        left: { start: { line: 1, offset: 1 } },
        right: { start: { line: 2, offset: 1 } },
      },
      iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
    },
  });
  expect(result.threads[0]?.[1]).toMatchObject({
    id: "11:2",
    replyTo: "11:1",
    isResolved: false,
  });
  expect(result.threads[1]?.[0]).toMatchObject({
    id: "13:3",
    location: { original: { path: "/src/stale.ts", right: { start: { line: 90 } } } },
  });
  expect(result.hasMore).toBe(false);
  expect(getThreads.mock.calls).toEqual([
    ["repo-id", 42, "Product"],
    ["repo-id", 42, "Product", 2],
  ]);
});

test("Azure unresolved filtering excludes fixed, won't-fix and by-design outcomes and applies thread limits", async () => {
  const provider = azureProvider({
    getThreads: async () => [
      ...[CommentThreadStatus.Fixed, CommentThreadStatus.WontFix, CommentThreadStatus.ByDesign].map(
        (status, id) => ({
          id: id + 1,
          status,
          comments: [{ id: id + 1, content: "Done", commentType: CommentType.Text }],
        }),
      ),
      ...[CommentThreadStatus.Active, CommentThreadStatus.Pending].map((status, id) => ({
        id: id + 4,
        status,
        comments: [{ id: id + 4, content: "Open", commentType: CommentType.Text }],
      })),
    ],
  });

  const result = await provider.listCommentThreads(ref, { unresolved: true, limit: 1 });

  expect(result.threads).toHaveLength(1);
  expect(result.hasMore).toBe(true);
});

test("Azure discussion-only results do not require diff iteration access", async () => {
  const getPullRequestIterations = mock<AzureGitClient["getPullRequestIterations"]>(async () => {
    throw new Error("Iterations unavailable");
  });
  const provider = azureProvider({
    getPullRequestIterations,
    getThreads: async () => [
      {
        id: 1,
        comments: [
          { id: 1, parentCommentId: 0, content: "Discussion", commentType: CommentType.Text },
        ],
      },
      {
        id: 2,
        comments: [{ id: 1, content: "System event", commentType: CommentType.System }],
      },
    ],
  });

  const result = await provider.listCommentThreads(ref, { limit: 10 });

  expect(result.threads).toHaveLength(1);
  expect(result.threads[0]?.[0]).toMatchObject({ id: "1:1", body: "Discussion" });
  expect(result.threads[0]?.[0]).not.toHaveProperty("replyTo");
  expect(result.threads[0]?.[0]).not.toHaveProperty("location");
  expect(getPullRequestIterations).not.toHaveBeenCalled();
});

test("Azure inline threads retain their original positions if tracking fails", async () => {
  const provider = azureProvider({
    getPullRequestIterations: async () => [{ id: 2 }],
    getThreads: async (_repository, _id, _project, iteration) => {
      if (iteration) throw new Error("Tracking unavailable");

      return [
        {
          id: 1,
          comments: [{ id: 1, content: "Deleted line", commentType: CommentType.Text }],
          threadContext: { filePath: "/src/old.ts", leftFileStart: { line: 9 } },
        },
      ];
    },
  });

  const result = await provider.listCommentThreads(ref, { limit: 10 });

  expect(result.threads[0]?.[0]?.location).toEqual({
    original: { path: "/src/old.ts", left: { start: { line: 9 }, end: undefined } },
  });
});
