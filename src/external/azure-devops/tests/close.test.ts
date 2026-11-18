import { expect, mock, test } from "bun:test";
import { PullRequestStatus } from "azure-devops-node-api/interfaces/GitInterfaces";
import { azurePr, azureProvider } from "./support/azure";

const ref = {
  provider: "azure-devops" as const,
  organizationUrl: "https://dev.azure.com/acme",
  id: 42,
};

test("Azure closes an active PR using discovered repository and project IDs", async () => {
  const update = mock(async () => azurePr({ status: PullRequestStatus.Abandoned }));
  const provider = azureProvider({ updatePullRequest: update });

  expect((await provider.closePullRequest(ref)).state).toBe("closed");
  expect(update).toHaveBeenCalledWith(
    { status: PullRequestStatus.Abandoned },
    "repo-id",
    42,
    "Product",
  );
});

test("Azure close is idempotent and refuses merged PRs without updating", async () => {
  for (const status of [PullRequestStatus.Abandoned, PullRequestStatus.Completed]) {
    const update = mock(async () => azurePr());
    const provider = azureProvider({
      getPullRequestById: async () => azurePr({ status }),
      updatePullRequest: update,
    });

    if (status === PullRequestStatus.Abandoned)
      expect((await provider.closePullRequest(ref)).state).toBe("closed");
    else
      await expect(provider.closePullRequest(ref)).rejects.toMatchObject({
        code: "SCM_INVALID_STATE",
      });
    expect(update).not.toHaveBeenCalled();
  }
});

test.each([
  [undefined, "SCM_PARTIAL_FAILURE"],
  [500, "SCM_PARTIAL_FAILURE"],
  [400, "SCM_INVALID_REQUEST"],
  [401, "SCM_AUTHENTICATION_FAILED"],
  [403, "SCM_ACCESS_DENIED"],
  [404, "SCM_NOT_FOUND"],
  [429, "SCM_RATE_LIMITED"],
] as const)(
  "Azure close distinguishes uncertain writes from rejection %s",
  async (statusCode, code) => {
    const update = mock(async () => {
      throw Object.assign(new Error("private diagnostic"), { statusCode });
    });
    const provider = azureProvider({ updatePullRequest: update });

    const failure = await provider.closePullRequest(ref).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain("private diagnostic");
    if (code === "SCM_PARTIAL_FAILURE")
      expect(String(failure)).toContain("Inspect the PR before retrying");
    expect(update).toHaveBeenCalledTimes(1);
  },
);

test("Azure close rejects mismatched preflight identity and reports invalid postwrite responses", async () => {
  const update = mock(async () => azurePr());
  const preflight = azureProvider({
    getPullRequestById: async () => azurePr({ pullRequestId: 99 }),
    updatePullRequest: update,
  });

  await expect(preflight.closePullRequest(ref)).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
  expect(update).not.toHaveBeenCalled();

  for (const response of [
    azurePr({ pullRequestId: 99, status: PullRequestStatus.Abandoned }),
    azurePr(),
  ]) {
    const write = mock(async () => response);
    const provider = azureProvider({ updatePullRequest: write });

    await expect(provider.closePullRequest(ref)).rejects.toMatchObject({
      code: "SCM_PARTIAL_FAILURE",
    });
    expect(write).toHaveBeenCalledTimes(1);
  }
});
