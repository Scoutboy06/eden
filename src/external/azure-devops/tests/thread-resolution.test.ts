import { expect, mock, test } from "bun:test";
import {
  CommentThreadStatus as Status,
  CommentType,
} from "azure-devops-node-api/interfaces/GitInterfaces";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import type { AzureGitClient } from "../provider";
import { azureProvider } from "./support/azure";

const ref: PullRequestRef = {
  provider: "azure-devops",
  organizationUrl: "https://dev.azure.com/acme",
  id: 42,
};
const discussion = { id: 7, comments: [{ id: 1, commentType: CommentType.Text }] };

test.each([
  [Status.Active, true, Status.Fixed],
  [Status.Pending, true, Status.Fixed],
  [undefined, true, Status.Fixed],
  [Status.Fixed, false, Status.Active],
  [Status.Closed, false, Status.Active],
  [Status.Pending, false, Status.Active],
] as const)(
  "Azure thread transitions from %s with resolve=%s to %s",
  async (current, resolve, expected) => {
    const getPullRequestThread = mock<AzureGitClient["getPullRequestThread"]>(async () => ({
      ...discussion,
      status: current,
    }));
    const updateThread = mock<AzureGitClient["updateThread"]>(async (patch) => ({
      ...discussion,
      ...patch,
    }));
    const provider = azureProvider({ getPullRequestThread, updateThread });

    const result = await provider.setReviewThreadResolution(ref, "7", resolve);

    expect(result).toEqual({ threadId: "7", isResolved: resolve, changed: true });
    expect(getPullRequestThread).toHaveBeenCalledWith("repo-id", 42, 7, "Product");
    expect(updateThread).toHaveBeenCalledWith({ status: expected }, "repo-id", 42, 7, "Product");
  },
);

test.each([
  [Status.Fixed, true],
  [Status.Closed, true],
  [Status.WontFix, true],
  [Status.ByDesign, true],
  [Status.Active, false],
] as const)("Azure leaves status %s unchanged with resolve=%s", async (status, resolve) => {
  const updateThread = mock<AzureGitClient["updateThread"]>(async () => ({}));
  const provider = azureProvider({
    getPullRequestThread: async () => ({ ...discussion, status }),
    updateThread,
  });

  const result = await provider.setReviewThreadResolution(ref, "7", resolve);

  expect(result).toEqual({ threadId: "7", isResolved: resolve, changed: false });
  expect(updateThread).not.toHaveBeenCalled();
});

test.each([
  { ...discussion, id: 8 },
  { ...discussion, isDeleted: true },
  { ...discussion, comments: [{ id: 1, commentType: CommentType.System }] },
])("Azure refuses to update a missing, deleted or system thread: %j", async (thread) => {
  const updateThread = mock<AzureGitClient["updateThread"]>(async () => ({}));
  const provider = azureProvider({
    getPullRequestThread: async () => ({ ...thread, comments: [...thread.comments] }),
    updateThread,
  });

  await expect(provider.setReviewThreadResolution(ref, "7", true)).rejects.toMatchObject({
    code: "SCM_NOT_FOUND",
  });

  expect(updateThread).not.toHaveBeenCalled();
});

test("Azure reports a partial failure when the returned status cannot confirm the write", async () => {
  const thread = { ...discussion, status: Status.Active };
  const provider = azureProvider({
    getPullRequestThread: async () => thread,
    updateThread: async () => thread,
  });

  await expect(provider.setReviewThreadResolution(ref, "7", true)).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
  });
});
