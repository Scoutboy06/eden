import { expect, mock, test } from "bun:test";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import type { AzureGitClient } from "../provider";
import { azurePr, azureProvider } from "./support/azure";

const ref: PullRequestRef = {
  provider: "azure-devops",
  organizationUrl: "https://dev.azure.com/acme",
  id: 42,
};

test("Azure label edits preserve unrelated labels, use label IDs for removals, and are idempotent", async () => {
  const labels = [
    { id: "untouched-id", name: "Unrelated" },
    { id: "remove-id", name: "1e669fd3-cc27-47c0-bbe5-753deed53d37" },
  ];
  const createPullRequestLabel = mock<AzureGitClient["createPullRequestLabel"]>(async (label) => {
    const added = { name: label.name ?? "", id: "new-id" };
    labels.push(added);
    return added;
  });
  const deletePullRequestLabels = mock<AzureGitClient["deletePullRequestLabels"]>(
    async (_repository, _pr, id) => {
      labels.splice(
        labels.findIndex((label) => label.id === id),
        1,
      );
    },
  );
  const updatePullRequest = mock<AzureGitClient["updatePullRequest"]>(async () => azurePr());
  const provider = azureProvider({
    getPullRequestLabels: async () => labels,
    createPullRequestLabel,
    deletePullRequestLabels,
    updatePullRequest,
  });
  const patch = { addLabels: ["unrelated", "New label"], removeLabels: [labels[1]!.name] };

  await provider.editPullRequest(ref, patch);
  await provider.editPullRequest(ref, patch);

  expect(createPullRequestLabel.mock.calls).toEqual([
    [{ name: "New label" }, "repo-id", 42, "Product"],
  ]);
  expect(deletePullRequestLabels.mock.calls).toEqual([["repo-id", 42, "remove-id", "Product"]]);
  expect(labels.map(({ name }) => name)).toEqual(["Unrelated", "New label"]);
  expect(updatePullRequest).not.toHaveBeenCalled();
});

test("Azure mixed edits stop before label writes when the metadata response identifies a different PR", async () => {
  const createPullRequestLabel = mock<AzureGitClient["createPullRequestLabel"]>(async () => ({}));
  const provider = azureProvider({
    createPullRequestLabel,
    updatePullRequest: async () => azurePr({ pullRequestId: 43 }),
  });

  await expect(
    provider.editPullRequest(ref, { title: "Updated", addLabels: ["new"] }),
  ).rejects.toMatchObject({ code: "SCM_PARTIAL_FAILURE" });

  expect(createPullRequestLabel).not.toHaveBeenCalled();
});

test("Azure label edits report partial failure if the provider does not confirm the requested state", async () => {
  const updatePullRequest = mock<AzureGitClient["updatePullRequest"]>(async () =>
    azurePr({ title: "Updated" }),
  );
  const createPullRequestLabel = mock<AzureGitClient["createPullRequestLabel"]>(async (label) => ({
    id: "new-id",
    name: label.name,
  }));
  const provider = azureProvider({ updatePullRequest, createPullRequestLabel });

  await expect(
    provider.editPullRequest(ref, { title: "Updated", addLabels: ["new"] }),
  ).rejects.toMatchObject({ code: "SCM_PARTIAL_FAILURE" });

  expect(updatePullRequest).toHaveBeenCalledWith({ title: "Updated" }, "repo-id", 42, "Product");
  expect(createPullRequestLabel).toHaveBeenCalledTimes(1);
});
