import { expect, mock, test } from "bun:test";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import { azurePr, azureProvider } from "./support/azure";
import type { AzureGitClient } from "../provider";

const ref: PullRequestRef = {
  provider: "azure-devops",
  organizationUrl: "https://dev.azure.com/acme",
  id: 42,
};
const guid = "b6f5a78d-8c3e-4f22-9d11-4f8361cc92a1";

test("Azure review requests reject mismatched PR identity before reviewer reads or writes", async () => {
  const read = mock<AzureGitClient["getPullRequestReviewers"]>(async () => []);
  const write = mock<AzureGitClient["createPullRequestReviewer"]>(async () => ({ id: guid }));
  const provider = azureProvider({
    getPullRequestById: async () => azurePr({ pullRequestId: 99 }),
    getPullRequestReviewers: read,
    createPullRequestReviewer: write,
  });

  await expect(provider.requestReview(ref, { reviewers: [guid], teams: [] })).rejects.toMatchObject(
    {
      code: "SCM_INVALID_RESPONSE",
    },
  );
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

test("Azure review requests use exact SDK identity arguments and ignore existing requests", async () => {
  const create = mock<AzureGitClient["createPullRequestReviewer"]>(async (reviewer) => ({
    ...reviewer,
    id: guid,
  }));
  const provider = azureProvider({
    getPullRequestReviewers: async () => [
      { id: guid.toUpperCase(), displayName: "Existing", vote: 0 },
    ],
    createPullRequestReviewer: create,
  });

  await expect(
    provider.requestReview(ref, { reviewers: [guid.toUpperCase(), guid], teams: [] }),
  ).resolves.toEqual({
    requested: [],
    alreadyPending: [guid.toLowerCase()],
  });
  expect(create).not.toHaveBeenCalled();
});

test("Azure review requests validate all GUIDs and reject teams before SDK reads", async () => {
  const getPullRequestById = mock<AzureGitClient["getPullRequestById"]>(async () => ({}));
  const provider = azureProvider({ getPullRequestById });

  await expect(
    provider.requestReview(ref, { reviewers: [guid, "alice"], teams: [] }),
  ).rejects.toMatchObject({ code: "SCM_INVALID_OPTIONS" });
  await expect(
    provider.requestReview(ref, { reviewers: [guid], teams: ["security"] }),
  ).rejects.toMatchObject({ code: "SCM_UNSUPPORTED_OPERATION" });
  expect(getPullRequestById).not.toHaveBeenCalled();
});

test("Azure review request failures report possible partial application without raw diagnostics", async () => {
  let calls = 0;
  const second = "c6f5a78d-8c3e-4f22-9d11-4f8361cc92a2";
  const provider = azureProvider({
    createPullRequestReviewer: async (reviewer, _repo, _id, reviewerId) => {
      calls += 1;
      if (reviewerId === second) throw new Error("secret diagnostic");
      return { ...reviewer, id: reviewerId };
    },
  });

  await expect(
    provider.requestReview(ref, { reviewers: [guid, second], teams: [] }),
  ).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
  });
  await expect(
    provider.requestReview(ref, { reviewers: [guid, second], teams: [] }),
  ).rejects.not.toHaveProperty("message", expect.stringContaining("secret diagnostic"));
  expect(calls).toBe(4);
});
