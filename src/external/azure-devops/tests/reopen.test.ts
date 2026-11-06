import { expect, mock, test } from "bun:test";
import { PullRequestStatus } from "azure-devops-node-api/interfaces/GitInterfaces";
import { azurePr, azureProvider } from "./support/azure";

const ref = {
  provider: "azure-devops" as const,
  organizationUrl: "https://dev.azure.com/acme",
  id: 42,
};

test("Azure reopens an abandoned PR in its discovered repository and project", async () => {
  const update = mock(async () => azurePr());
  const provider = azureProvider({
    getPullRequestById: async () => azurePr({ status: PullRequestStatus.Abandoned }),
    updatePullRequest: update,
  });

  expect((await provider.reopenPullRequest(ref)).state).toBe("open");
  expect(update).toHaveBeenCalledWith(
    { status: PullRequestStatus.Active },
    "repo-id",
    42,
    "Product",
  );
});

test.each([PullRequestStatus.Active, PullRequestStatus.Completed])(
  "Azure does not mutate a PR in state %s when reopening",
  async (status) => {
    const update = mock(async () => azurePr());
    const provider = azureProvider({
      getPullRequestById: async () => azurePr({ status }),
      updatePullRequest: update,
    });

    if (status === PullRequestStatus.Active)
      expect((await provider.reopenPullRequest(ref)).state).toBe("open");
    else
      await expect(provider.reopenPullRequest(ref)).rejects.toMatchObject({
        code: "SCM_INVALID_STATE",
      });
    expect(update).not.toHaveBeenCalled();
  },
);

test.each(["identity", "state", "malformed"])(
  "Azure reports possibly-applied reopen for invalid response %s",
  async (problem) => {
    const update = mock(async () =>
      azurePr(
        problem === "identity"
          ? { pullRequestId: 99 }
          : problem === "state"
            ? { status: PullRequestStatus.Abandoned }
            : { title: undefined },
      ),
    );
    const provider = azureProvider({
      getPullRequestById: async () => azurePr({ status: PullRequestStatus.Abandoned }),
      updatePullRequest: update,
    });

    await expect(provider.reopenPullRequest(ref)).rejects.toMatchObject({
      code: "SCM_PARTIAL_FAILURE",
    });
    expect(update).toHaveBeenCalledTimes(1);
  },
);

test("Azure reopen rejects cross-organization and mismatched PR targets before updates", async () => {
  const read = mock(async () =>
    azurePr({ pullRequestId: 99, status: PullRequestStatus.Abandoned }),
  );
  const update = mock(async () => azurePr());
  const provider = azureProvider({ getPullRequestById: read, updatePullRequest: update });

  await expect(
    provider.reopenPullRequest({ ...ref, organizationUrl: "https://dev.azure.com/other" }),
  ).rejects.toMatchObject({ code: "SCM_PROVIDER_MISMATCH" });
  expect(read).not.toHaveBeenCalled();
  await expect(provider.reopenPullRequest(ref)).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
  expect(update).not.toHaveBeenCalled();
});
